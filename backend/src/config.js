import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce.number().default(4010),
  HASHKEY_RPC_URL: z.string().url().default("https://testnet.hsk.xyz"),
  HASHKEY_CHAIN_ID: z.coerce.number().default(133),
  CORS_ORIGIN: z.string().default("*"),
  ADMIN_API_KEY: z.string().optional(),
  PRIVATE_KEY: z.string().optional(),
  ADMIN_PRIVATE_KEY: z.string().optional(),
  ISSUER_PRIVATE_KEY: z.string().optional(),
  ADMIN_ADDRESS: z.string().optional(),
  ISSUER_ADDRESS: z.string().optional(),
  COMPLIANCE_REGISTRY_ADDRESS: z.string().optional(),
  SERVICED_ASSET_TOKEN_ADDRESS: z.string().optional(),
  DISTRIBUTION_MODULE_ADDRESS: z.string().optional(),
  REDEMPTION_MODULE_ADDRESS: z.string().optional(),
  SETTLEMENT_TOKEN_ADDRESS: z.string().optional(),
  ORACLE_ROUTER_ADDRESS: z.string().optional()
});

export const config = configSchema.parse(process.env);
