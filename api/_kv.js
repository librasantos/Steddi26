// api/_kv.js — Compatibility shim for @vercel/kv using @upstash/redis
//
// Errors are swallowed and logged — backend calls fail gracefully when KV
// isn't configured. Calendar sync UI is hidden in the frontend as of
// April 14 2026, so failures here don't surface to the user.

import { Redis } from '@upstash/redis';

let _client = null;

function getClient() {
  if (_client) return _client;
  try {
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      _client = new Redis({
        url: process.env.KV_REST_API_URL,
        token: process.env.KV_REST_API_TOKEN,
      });
      return _client;
    }
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      _client = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });
      return _client;
    }
    _client = Redis.fromEnv();
    return _client;
  } catch (err) {
    console.error('[_kv] Failed to initialize Redis client:', err?.message);
    return null;
  }
}

export const kv = {
  async get(key) {
    const client = getClient();
    if (!client) return null;
    try {
      return await client.get(key);
    } catch (err) {
      console.error(`[_kv] get(${key}) failed:`, err?.message);
      return null;
    }
  },

  async set(key, value, options) {
    const client = getClient();
    if (!client) return null;
    try {
      if (options && typeof options === 'object' && options.ex) {
        return await client.set(key, value, { ex: options.ex });
      }
      return await client.set(key, value);
    } catch (err) {
      console.error(`[_kv] set(${key}) failed:`, err?.message);
      return null;
    }
  },

  async incr(key) {
    const client = getClient();
    if (!client) return 0;
    try {
      return await client.incr(key);
    } catch (err) {
      console.error(`[_kv] incr(${key}) failed:`, err?.message);
      return 0;
    }
  },

  async expire(key, seconds) {
    const client = getClient();
    if (!client) return false;
    try {
      return await client.expire(key, seconds);
    } catch (err) {
      console.error(`[_kv] expire(${key}) failed:`, err?.message);
      return false;
    }
  },

  async del(key) {
    const client = getClient();
    if (!client) return 0;
    try {
      return await client.del(key);
    } catch (err) {
      console.error(`[_kv] del(${key}) failed:`, err?.message);
      return 0;
    }
  },

  async sadd(key, ...members) {
    const client = getClient();
    if (!client) return 0;
    try {
      return await client.sadd(key, ...members);
    } catch (err) {
      console.error(`[_kv] sadd(${key}) failed:`, err?.message);
      return 0;
    }
  },

  async smembers(key) {
    const client = getClient();
    if (!client) return [];
    try {
      const members = await client.smembers(key);
      return Array.isArray(members) ? members : [];
    } catch (err) {
      console.error(`[_kv] smembers(${key}) failed:`, err?.message);
      return [];
    }
  },

  async srem(key, ...members) {
    const client = getClient();
    if (!client) return 0;
    try {
      return await client.srem(key, ...members);
    } catch (err) {
      console.error(`[_kv] srem(${key}) failed:`, err?.message);
      return 0;
    }
  },
};
