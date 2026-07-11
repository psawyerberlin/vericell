import { z } from "zod";

const SHA256_RE = /^[0-9a-fA-F]{64}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export const TxHashParams = z.object({
  txHash: z.string().regex(TX_HASH_RE, "must be a 0x-prefixed 32-byte hex transaction hash"),
});

export const Sha256Params = z.object({
  sha256: z
    .string()
    .regex(SHA256_RE, "must be a 64-character hex SHA-256 hash")
    .transform((s) => s.toLowerCase()),
});

export const UnidParams = z.object({
  unid: z.string().min(1),
});

export const ProjectsQuery = z.object({
  q: z.string().trim().min(1).optional(),
  hash: z
    .string()
    .regex(SHA256_RE, "must be a 64-character hex SHA-256 hash")
    .transform((s) => s.toLowerCase())
    .optional(),
  address: z.string().trim().min(1).optional(),
  active: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ProjectsQueryParsed = z.infer<typeof ProjectsQuery>;
