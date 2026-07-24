// Serverless proxy: клик по кнопке «Обновить данные» на margin-dashboard
// → POST на этот endpoint → он вызывает GitHub Actions workflow_dispatch.
// PAT хранится в env var GH_PAT (Vercel Project Settings → Environment Variables).

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'POST') {
    return new Response('Use POST', { status: 405, headers: CORS });
  }

  const token = (globalThis as any).process?.env?.GH_PAT as string | undefined;
  if (!token) {
    return new Response(JSON.stringify({ error: 'GH_PAT not configured' }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const url =
    'https://api.github.com/repos/KaterZakharova/margin-daval-dashboard/actions/workflows/refresh.yml/dispatches';

  const gh = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'margin-dashboard-refresh-button',
    },
    body: JSON.stringify({ ref: 'master' }),
  });

  if (gh.status === 204) {
    return new Response(
      JSON.stringify({
        ok: true,
        message: 'Запущено. Обновление займёт ~10 минут — потом обновите страницу.',
        actionsUrl:
          'https://github.com/KaterZakharova/margin-daval-dashboard/actions/workflows/refresh.yml',
      }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }

  const body = await gh.text();
  return new Response(
    JSON.stringify({ ok: false, status: gh.status, error: body }),
    { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } }
  );
}
