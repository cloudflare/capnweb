// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { expect, it, describe } from "vitest"
import { FlowController, type SendToken } from "../src/streams.js"

// To emulate random-ish chunk sizes while keeping the test reproducible, we cycle through this
// list of sizes.
const CHUNK_SIZES = [32 * 1024, 4 * 1024, 16000, 12345, 16, 9999, 4321, 8];

// Helper: simulates a stream with a fake clock and set RTT and bandwidth. Sends chunks, advances
// time, and acks in order.
class StreamSimulator {
  // Default RTT of 100ms.
  rtt = 100;

  // Default bandwidth of 10kB/ms = 10MB/s = 1MB/RTT. This is larger than the initial window size
  // of 256k, so the window should grow if staurated. Individual test cases may set something
  // different, or modify the properties during the test.
  bandwidth = 10 * 1024;

  // Convenience getter to calculate BDP.
  get bdp() { return this.rtt * this.bandwidth; }

  // Current simulated time.
  t = 0;

  // Are we currently blocked, according to the flow controller's return values from onSend/onAck?
  blocked = false;

  // The outgoing link is sending bytes (for a previous send()) until this time. Subsequent sends
  // cannot start until after this time. This is how we simulate bandwidth constraints.
  linkOccupiedUntil = 0;

  // The flow controller itself.
  fc = new FlowController(() => this.t);

  // In-flight writes, in send order. Each has its token and scheduled ack time.
  inFlight: { token: SendToken, ackTime: number }[] = [];

  // Send a chunk at the current time.
  send(size: number) {
    // The new message begins sending now, unless some other message is still sending, in which
    // case it sends after that message. It occupies the link until all the bytes are sent, based
    // on the bandwidth.
    this.linkOccupiedUntil = Math.max(this.linkOccupiedUntil, this.t) + size / this.bandwidth;

    let { token, shouldBlock } = this.fc.onSend(size);

    // ackTime = time when the chunk finishes writing out to the pipe, plus 1 rtt
    this.inFlight.push({ token, ackTime: this.linkOccupiedUntil + this.rtt });
    this.blocked = shouldBlock;
  }

  // Fill the window by sending chunks of the given size. Returns the number of chunks sent
  // (the last one caused blocking).
  fillWindow(chunkSize: number): number {
    let count = 0;
    while (!this.blocked) {
      count++;
      this.send(chunkSize);
    }
    return count;
  }

  // Advance to the next message's ack time, and deliver the ack to the flow controller.
  waitForNextAck() {
    let entry = this.inFlight.shift();
    if (entry) {
      this.t = entry.ackTime;
      if (this.fc.onAck(entry.token)) {
        this.blocked = false;
      }
    }
  }

  // Simulate the application writing to the stream as fast as it can for the given duration.
  saturateFor(duration: number): void {
    let endTime = this.t + duration;
    let i = 0;

    // Send chunks until blocked, then wait for acks until unblocked. Repeat until the end time
    // is reached.
    while (this.t < endTime) {
      if (this.blocked) {
        this.waitForNextAck();
      } else {
        this.send(CHUNK_SIZES[i++ % CHUNK_SIZES.length]);
      }
    }

    // Drain remaining acks.
    while (this.inFlight.length > 0) {
      this.waitForNextAck();
    }
  }
}

describe("FlowController", () => {
  it("blocks when window is full", () => {
    let sim = new StreamSimulator();
    let initialWindow = sim.fc.window;  // 256KB

    // Send chunks until blocked.
    let count = sim.fillWindow(64 * 1024);
    expect(count).toBe(4);  // 4 * 64KB = 256KB = window
    expect(sim.fc.bytesInFlight).toBe(initialWindow);
  });

  it("unblocks after ack frees space", () => {
    let sim = new StreamSimulator();

    // Send 4 chunks at staggered times so acks arrive at different times.
    sim.t = 0;
    sim.send(64 * 1024);
    sim.t = 1;
    sim.send(64 * 1024);
    sim.t = 2;
    sim.send(64 * 1024);
    sim.t = 3;
    expect(sim.blocked).toBe(false);
    sim.send(64 * 1024);
    expect(sim.blocked).toBe(true);

    // Ack only the first one.
    sim.waitForNextAck();
    expect(sim.fc.bytesInFlight).toBe(192 * 1024);  // 3 chunks still in flight
  });

  it("window grows during startup", () => {
    let sim = new StreamSimulator();

    let initialWindow = sim.fc.window;  // 256KB
    // Simulate for a few RTTs — window should grow toward the BDP.
    sim.saturateFor(sim.rtt * 5);

    // During startup, window should quickly grow past the 1MB BDP.
    expect(sim.fc.window).toBeGreaterThan(initialWindow);
    expect(sim.fc.window).toBeGreaterThan(sim.bdp);
  });

  it("exits startup after window growth plateaus", () => {
    let sim = new StreamSimulator();

    expect(sim.fc.inStartupPhase).toBe(true);

    // Simulate for long enough that startup exits.
    sim.saturateFor(sim.rtt * 50);

    expect(sim.fc.inStartupPhase).toBe(false);
  });

  it("steady-state window converges near BDP", () => {
    let sim = new StreamSimulator();

    // Run through startup.
    sim.saturateFor(sim.rtt * 50);
    expect(sim.fc.inStartupPhase).toBe(false);

    // Window should have settled around 25% above BDP.
    expect(sim.fc.window).toBeGreaterThan(sim.bdp * 1.2);
    expect(sim.fc.window).toBeLessThan(sim.bdp * 1.3);

    // Keep running.
    sim.saturateFor(sim.rtt * 20);

    // Window should be pretty stable.
    expect(sim.fc.window).toBeGreaterThan(sim.bdp * 1.2);
    expect(sim.fc.window).toBeLessThan(sim.bdp * 1.3);
  });

  it("window does not shrink when app-limited", () => {
    let sim = new StreamSimulator();

    // Run through startup to establish a window.
    sim.saturateFor(sim.rtt * 50);
    let windowAfterStartup = sim.fc.window;

    // Now repeatedly send small chunks that don't fill the window, waiting for each one.
    for (let i = 0; i < 50; i++) {
      sim.send(1024);
      sim.waitForNextAck();
    }

    // Window should not have shrunk.
    expect(sim.fc.window).toStrictEqual(windowAfterStartup);
  });

  it("window shrinks when pipe bandwidth decreases", () => {
    let sim = new StreamSimulator();

    // Run through startup at full speed — window should grow well above INITIAL_WINDOW.
    sim.saturateFor(sim.rtt * 50);
    expect(sim.fc.inStartupPhase).toBe(false);
    expect(sim.fc.window).toBeGreaterThan(sim.bdp);

    // Simulate pipe bandwidth drop to 1/4 of original. The sender still tries to fill the
    // window, but acks arrive more slowly (bottleneck delivers chunks at 1/4 the rate).
    sim.bandwidth /= 4;
    sim.saturateFor(sim.rtt * 200);

    // The window should have decayed, and is now closer to the new, lower bdp.
    expect(sim.fc.window).toBeLessThan(sim.bdp * 2);
  });

  it("onError restores bytesInFlight without changing window", () => {
    let sim = new StreamSimulator();

    let { token } = sim.fc.onSend(64 * 1024);
    expect(sim.fc.bytesInFlight).toBe(64 * 1024);

    let windowBefore = sim.fc.window;
    sim.fc.onError(token);
    expect(sim.fc.bytesInFlight).toBe(0);
    expect(sim.fc.window).toBe(windowBefore);
  });

  it("growth collar limits window increase to growthFactor per RTT", () => {
    let sim = new StreamSimulator();
    let chunkSize = 64 * 1024;

    // Do a first round to get past the first-ack bootstrap.
    sim.fillWindow(chunkSize);
    sim.waitForNextAck();

    // Record the initial window.
    let windowBefore = sim.fc.window;

    // Do another round.
    sim.fillWindow(chunkSize);
    // Ack all of them.
    while (sim.inFlight.length > 0) {
      sim.waitForNextAck();
    }

    // In startup, window can at most double per RTT (STARTUP_GROWTH_FACTOR = 2).
    expect(sim.fc.window).toBeLessThanOrEqual(windowBefore * 2 + 1);
  });

  it("minimum window is enforced", () => {
    let sim = new StreamSimulator();

    // Set RTT and bandwidth excessively low, to create a low BDP.
    sim.rtt = 1;
    sim.bandwidth = 1;

    // We're going to have to run for quite a while since bandwidth is so low.
    sim.saturateFor(10000000);

    // Window should have been clamped at MIN_WINDOW.
    expect(sim.fc.window).toStrictEqual(64 * 1024);
  });
});
