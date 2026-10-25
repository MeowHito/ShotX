/** ALB health check (infra `services.web.healthCheckPath`). No dependencies: liveness only. */
export function GET() {
  return new Response('ok', {
    status: 200,
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
  });
}

export const dynamic = 'force-dynamic';
