import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DB_PATH: z.string().default("./data/lottery.sqlite"),
  UPLOAD_DIR: z.string().default("./uploads"),
  CORS_ORIGIN: z.string().default("http://localhost:5173")
});

const parsed = envSchema.parse(process.env);

export const config = {
  port: parsed.PORT,
  dbPath: path.resolve(process.cwd(), parsed.DB_PATH),
  uploadDir: path.resolve(process.cwd(), parsed.UPLOAD_DIR),
  corsOrigin: parsed.CORS_ORIGIN
};

