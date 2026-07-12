export const WEBHOOK_EVENTS = ["committed", "consumed", "superseded"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookEventPayload {
  event: WebhookEvent;
  unid: string;
  tx_hash: string;
  version_no: number | null;
  project_sha256: string | null;
  title: string | null;
  block_number: number | null;
  block_time: string | null;
  /** Set only for `superseded`: the tx hash of the new live version. */
  successor_tx_hash?: string;
}
