import { ccc } from "@ckb-ccc/ccc";

/**
 * The subset of `ccc.Client` the indexer needs. A real client (`chain`'s
 * `makeClient()`) satisfies this structurally — no adapter required. Tests
 * can pass a plain object literal instead of subclassing `ccc.Client`'s many
 * abstract members.
 */
export interface IndexerClient {
  getTip(): Promise<ccc.Num>;
  getBlockByNumber(blockNumber: ccc.NumLike): Promise<ccc.ClientBlock | undefined>;
  getKnownScript(script: ccc.KnownScript): Promise<ccc.ScriptInfo>;
  /** Used to render `projects.ckb_address` — see `Client.addressPrefix`. */
  readonly addressPrefix: string;
}
