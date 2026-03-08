import { RpcStub, RpcTarget } from "../src/index.js"
import {
  expectAssignable,
  expectType,
  type Dec,
  type Equal,
  type Expect,
  type IsAny,
} from "./helpers.js"

class Worker extends RpcTarget {
  compute(input: number): number {
    return input
  }
}

class Cursor extends RpcTarget {
  next(): Promise<Cursor> {
    return Promise.resolve(this)
  }

  get score(): number {
    return 0
  }

  getWorker(): Promise<Worker> {
    return Promise.resolve(new Worker())
  }
}

type GraphNode = {
  id: string
  parent: Promise<GraphNode | null>
  children: Promise<GraphNode[]>
  links: Map<string, Promise<GraphNode>>
  checkpoints: readonly [at: number, previous: Promise<GraphNode> | null]
}

type GraphEnvelope =
  | {
      kind: "node"
      node: Promise<GraphNode>
      extras: Array<Promise<GraphNode>>
    }
  | {
      kind: "cursor"
      cursor: Promise<Cursor>
      history: Promise<GraphEnvelope[]>
    }

interface RecursiveComplexApi {
  root(): Promise<GraphNode>
  merge(
    envelope: GraphEnvelope,
    hops: number | Promise<number>
  ): Promise<{
    envelope: GraphEnvelope
    node: GraphNode
    cursor: Cursor
  }>
  cursor(): Promise<Cursor>
  useWorker(worker: RpcStub<Worker>, nodeId: string | Promise<string>): Promise<number>
}

declare const api: RpcStub<RecursiveComplexApi>
declare const localNode: GraphNode
declare const localCursor: Cursor
const localWorker = new RpcStub(new Worker())

const merged = api.merge(
  {
    kind: "node",
    node: Promise.resolve(localNode),
    extras: [Promise.resolve(localNode), Promise.resolve(localNode)],
  },
  Promise.resolve(2)
)
expectAssignable<Promise<"node" | "cursor">>(merged.envelope.kind)
expectAssignable<Promise<string>>(merged.node.id)
expectAssignable<Promise<number>>(merged.cursor.next().score)

const mergedCursor = api.merge(
  {
    kind: "cursor",
    cursor: Promise.resolve(localCursor),
    history: Promise.resolve([]),
  },
  1
)
expectAssignable<Promise<"node" | "cursor">>(mergedCursor.envelope.kind)
expectAssignable<Promise<number>>(mergedCursor.cursor.score)

const deepCursor = api
  .cursor()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
  .next()
expectAssignable<Promise<number>>(deepCursor.score)
expectAssignable<Promise<number>>(deepCursor.getWorker().compute(api.cursor().score))

expectAssignable<Promise<number>>(api.useWorker(localWorker, api.root().id))

// Regression guard: this depth exceeds prior capped-recursion limits.
type DeepTree<N extends number> = N extends 0
  ? { leaf: true; id: string }
  : { id: string; next: Promise<DeepTree<Dec<N>>>; siblings: Array<Promise<DeepTree<Dec<N>>>> }

interface DeepTreeApi {
  roundTrip(tree: DeepTree<48>): Promise<DeepTree<48>>
}

declare const deepTreeApi: RpcStub<DeepTreeApi>
declare const localDeepTree: DeepTree<48>

const deepTreeResult = deepTreeApi.roundTrip(localDeepTree)
expectAssignable<Promise<string>>(deepTreeResult.next.next.next.next.next.id)

type RootShape = Awaited<ReturnType<typeof api.root>>
type MergeShape = Awaited<ReturnType<typeof api.merge>>
type CursorShape = Awaited<ReturnType<typeof api.cursor>>

async function assertRecursiveShapes() {
  const root = await api.root()
  expectType<string>(root.id)
  expectAssignable<{ id: string } | null>(root.parent)
  expectAssignable<{ id: string }>(root.children[0])
  expectAssignable<{ id: string } | undefined>(root.links.get("primary"))

  const mergedResult = await api.merge(
    {
      kind: "cursor",
      cursor: Promise.resolve(localCursor),
      history: Promise.resolve([]),
    },
    2
  )
  expectType<MergeShape>(mergedResult)
  expectType<CursorShape>(mergedResult.cursor)
  expectType<string>(mergedResult.node.id)
}

void assertRecursiveShapes

type _RootAwaited = Awaited<ReturnType<typeof api.root>>
type _MergeAwaited = Awaited<ReturnType<typeof api.merge>>
type _RootNotAny = Expect<Equal<IsAny<_RootAwaited>, false>>
type _MergeNotAny = Expect<Equal<IsAny<_MergeAwaited>, false>>

// Negative checks.

// @ts-expect-error merge requires valid envelope variant
api.merge({ kind: "missing", node: api.root() }, 1)

// @ts-expect-error nodeId must be string-like
api.useWorker(localWorker, true)

// @ts-expect-error deep cursor score is number, not string
const invalidScoreType: Promise<string> = deepCursor.score
