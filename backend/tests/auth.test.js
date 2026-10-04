'use strict';

/** Authentication tests: register, login, logout, /me, validation, guards. */

const { app, authClient, clearDb, createUser, request, startDb, stopDb } = require('./helpers');
const User = require('../src/models/User');

beforeAll(startDb);
afterAll(stopDb);
beforeEach(clearDb);

describe('POST /api/auth/register', () => {
  it('creates an account and returns a token', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ada Lovelace', email: 'ada@example.test', password: 'Password123!' });

    expect(response.status).toBe(201);
    expect(response.body.token).toEqual(expect.any(String));
    expect(response.body.user.email).toBe('ada@example.test');
    expect(response.body.user).not.toHaveProperty('passwordHash');
  });

  it('never returns the password hash', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Grace', email: 'grace@example.test', password: 'Password123!' });

    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
  });

  it('stores the password hashed with bcrypt (not in plain text)', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Linus', email: 'linus@example.test', password: 'Password123!' });

    const user = await User.findOne({ email: 'linus@example.test' }).select('+passwordHash');
    expect(user.passwordHash).not.toBe('Password123!');
    expect(user.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(await user.verifyPassword('Password123!')).toBe(true);
  });

  it('rejects a duplicate email with 409', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'First', email: 'dup@example.test', password: 'Password123!' });

    const response = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Second', email: 'dup@example.test', password: 'Password123!' });

    expect(response.status).toBe(409);
  });

  it.each([
    [{ email: 'no-name@example.test', password: 'Password123!' }, 'name'],
    [{ name: 'No Email', password: 'Password123!' }, 'email'],
    [{ name: 'Bad Email', email: 'not-an-email', password: 'Password123!' }, 'email'],
    [{ name: 'Short', email: 'short@example.test', password: 'abc' }, 'password'],
  ])('rejects invalid registration input (%#)', async (payload) => {
    const response = await request(app).post('/api/auth/register').send(payload);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
  });
});

describe('POST /api/auth/login', () => {
  it('returns a token for valid credentials', async () => {
    await createUser({ email: 'login@example.test', password: 'Secret123!' });

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@example.test', password: 'Secret123!' });

    expect(response.status).toBe(200);
    expect(response.body.token).toEqual(expect.any(String));
  });

  it('is case-insensitive on the email', async () => {
    await createUser({ email: 'case@example.test', password: 'Secret123!' });
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'CASE@example.test', password: 'Secret123!' });
    expect(response.status).toBe(200);
  });

  it('rejects a wrong password with 401', async () => {
    await createUser({ email: 'wrong@example.test', password: 'Secret123!' });
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'wrong@example.test', password: 'Nope123!' });
    expect(response.status).toBe(401);
  });

  it('gives the same message for unknown user and wrong password', async () => {
    await createUser({ email: 'real@example.test', password: 'Secret123!' });
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.test', password: 'Secret123!' });
    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ email: 'real@example.test', password: 'Bad12345!' });

    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe(wrong.body.error);
  });
});

describe('GET /api/auth/me', () => {
  it('returns the current user for a valid token', async () => {
    const user = await createUser({ email: 'me@example.test' });
    const client = await authClient(user);

    const response = await client.get('/api/auth/me');
    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe('me@example.test');
  });

  it('rejects a missing token with 401', async () => {
    const response = await request(app).get('/api/auth/me');
    expect(response.status).toBe(401);
  });

  it('rejects a tampered token with 401', async () => {
    const user = await createUser({ email: 'tamper@example.test' });
    const client = await authClient(user);
    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${client.token}x`);
    expect(response.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('succeeds for an authenticated user', async () => {
    const user = await createUser({ email: 'out@example.test' });
    const client = await authClient(user);
    const response = await client.post('/api/auth/logout');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});

describe('roles', () => {
  it('makes the very first registered user an admin and later ones users', async () => {
    const first = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Admin', email: 'admin@example.test', password: 'Password123!' });
    const second = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Member', email: 'member@example.test', password: 'Password123!' });

    expect(first.body.user.role).toBe('admin');
    expect(second.body.user.role).toBe('user');
  });
});