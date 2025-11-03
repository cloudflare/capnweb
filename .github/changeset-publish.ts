import { execSync } from "node:child_process";

execSync("npx changeset publish", {
  stdio: "inherit",
});
