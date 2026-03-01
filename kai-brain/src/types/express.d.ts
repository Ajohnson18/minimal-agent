import type { AuthContext } from "../lib/auth/jwt.js";

declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
      auth?: AuthContext;
    }
  }
}

export {};
