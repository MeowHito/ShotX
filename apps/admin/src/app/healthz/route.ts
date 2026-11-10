/** Health check (load balancer / compose). No dependencies: liveness only. */
export function GET() {
  return new Response('ok', {
    status: 200,
    headers: {
      'content-type': 'text/plain',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

export const dynamic = 'force-dynamic';
