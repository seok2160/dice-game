import 'dotenv/config';
import http from 'http';
import express from 'express';
import path from 'path';
import { Server } from 'socket.io';
import { MemoryStore } from './store/MemoryStore';
import { registerHandlers } from './server/handlers';

const PORT          = Number(process.env.PORT ?? 8080);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const app    = express();
const server = http.createServer(app);

let publicUrl = '';

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health',          (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get('/api/tunnel-url',  (_req, res) => res.json({ url: publicUrl }));
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html')),
);

const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  cors: { origin: '*' },
  pingTimeout:    60000,  // 모바일 백그라운드 전환 대응 (기본 20s → 60s)
  pingInterval:   25000,  // 배터리 절약 겸 안정성 (기본 25s 유지)
  connectTimeout: 60000,
});

const store     = new MemoryStore();
const scheduler = registerHandlers(io, store);
scheduler.on('error', (e) => console.error('[scheduler]', e));

// ─── 클라우드 배포 시 process.env.RAILWAY_PUBLIC_DOMAIN 등을 사용 ──────────────
function getCloudUrl(): string {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.RENDER_EXTERNAL_URL)   return process.env.RENDER_EXTERNAL_URL;
  return '';
}

// ─── 로컬 개발 전용 Cloudflare 터널 ──────────────────────────────────────────
function startLocalTunnel(): void {
  try {
    // cloudflared 는 devDependency — 프로덕션 빌드에 없어도 안전하게 무시
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Tunnel, install, bin } = require('cloudflared') as typeof import('cloudflared');
    install(bin).then(() => {
      const t = Tunnel.quick(`http://localhost:${PORT}`);
      t.once('url', (url: string) => {
        publicUrl = url;
        console.log(`  공개  : ${url}  ← 이 주소를 공유하세요`);
      });
      t.on('error', (e: Error) => console.error('[tunnel]', e.message));
      t.on('exit',  ()         => { publicUrl = ''; });
      process.on('SIGTERM', () => { t.stop(); server.close(); process.exit(0); });
      process.on('SIGINT',  () => { t.stop(); server.close(); process.exit(0); });
    }).catch((e: Error) => console.warn('  터널 시작 실패:', e.message));
  } catch {
    console.log('  (cloudflared 없음 — 로컬 전용 모드)');
    process.on('SIGTERM', () => { server.close(); process.exit(0); });
    process.on('SIGINT',  () => { server.close(); process.exit(0); });
  }
}

server.listen(PORT, () => {
  console.log(`\n  Dice Board Game Server`);
  console.log(`  ──────────────────────────────`);

  if (IS_PRODUCTION) {
    const cloud = getCloudUrl();
    if (cloud) {
      publicUrl = cloud;
      console.log(`  URL   : ${cloud}`);
    } else {
      console.log(`  URL   : http://localhost:${PORT}  (PORT=${PORT})`);
    }
    console.log(`  모드  : production\n`);
    process.on('SIGTERM', () => { server.close(); process.exit(0); });
    process.on('SIGINT',  () => { server.close(); process.exit(0); });
  } else {
    console.log(`  로컬  : http://localhost:${PORT}`);
    console.log(`  공개 URL 생성 중...`);
    startLocalTunnel();
  }
});
