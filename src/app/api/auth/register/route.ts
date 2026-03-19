import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcrypt';
import pool, { initDB } from '@/lib/db';
import { createSession } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    await initDB();
    const { email, password, name } = await req.json();

    if (!email || !password) {
      return NextResponse.json({ error: 'Email et mot de passe requis' }, { status: 400 });
    }

    // Vérifier si l'email existe déjà
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return NextResponse.json({ error: 'Cet email est déjà utilisé' }, { status: 409 });
    }

    const id = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date().toISOString();

    await pool.query(
      'INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)',
      [id, email, name || '', passwordHash, now]
    );

    await createSession({ userId: id, email, name: name || '' });

    return NextResponse.json({ id, email, name: name || '' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Erreur inconnue';
    console.error('Register error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
