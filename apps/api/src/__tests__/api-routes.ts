import request from 'supertest';
import type { createApp } from '../index.js';

type App = ReturnType<typeof createApp>;

interface RouteLayer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
}

interface AppLayer {
  handle?: { stack?: RouteLayer[] };
  match(path: string): boolean;
}

/**
 * Every route the app serves under /api, as "METHOD /api/path", read off the
 * app itself rather than a list someone keeps: a route added tomorrow shows up
 * here whether or not anyone remembered to list it.
 */
export function registeredApiRoutes(app: App): string[] {
  const stack = (app as unknown as { router: { stack: AppLayer[] } }).router.stack;
  const keys: string[] = [];
  for (const layer of stack) {
    const routes = layer.handle?.stack;
    if (!routes || !layer.match('/api/__probe__')) continue;
    for (const { route } of routes) {
      if (!route) continue;
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      for (const method of Object.keys(route.methods)) {
        for (const p of paths) keys.push(`${method.toUpperCase()} /api${p}`);
      }
    }
  }
  return keys;
}

/** Sends `METHOD /api/...` with a harmless body, filling in any `:id`. */
export function callRoute(app: App, key: string) {
  const [method, rawPath] = key.split(' ');
  const url = rawPath.replace(':id', 'sched-does-not-exist');
  const agent = request(app);
  switch (method) {
    case 'GET':
      return agent.get(url);
    case 'DELETE':
      return agent.delete(url);
    default:
      return agent.post(url).send({});
  }
}
