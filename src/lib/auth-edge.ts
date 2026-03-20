/**
 * Vérification JWT compatible Edge Runtime (middleware).
 * Pas d'import next/headers ici — le middleware n'y a pas accès.
 */
import { jwtVerify } from 'jose';

export interface SessionPayload {
  userId: string;
  email: string;
  name: string;
}

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-in-production';
  return new TextEncoder().encode(secret);
}

export async function verifyToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return {
      userId: payload.userId as string,
      email: payload.email as string,
      name: payload.name as string,
    };
  } catch {
    return null;
  }
}
