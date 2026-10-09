import { Innertube } from 'youtubei.js';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function videoId(raw) {
  try {
    const u = new URL(raw);
    if (u.hostname === 'youtu.be') {
      return u.pathname.slice(1).split('/')[0];
    }
    if (u.hostname.endsWith('youtube.com')) {
      return (
        u.searchParams.get('v') ||
        u.pathname.match(/\/shorts\/([^/]+)/)?.[1] ||
        u.pathname.match(/\/embed\/([^/]+)/)?.[1] ||
        ''
      );
    }
  } catch {}
  return '';
}

function safeName(value) {
  return String(value || 'YouTube Audio')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'YouTube Audio';
}

async function readProcessError(proc) {
  const chunks = [];
  for await (const chunk of proc.stderr) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

export default async (req) => {
  // Simple health check so the deployed Function can be tested directly.
  if (req.method === 'GET') {
    return json({ ok: true, function: 'youtube-to-mp3' });
  }

  if (req.method !== 'POST') {
    return json({ error: 'POST만 지원합니다.' }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: '잘못된 요청입니다.' }, 400);
  }

  const id = videoId(String(body?.url || ''));
  if (!id) {
    return json({ error: '유효한 YouTube 링크를 입력해 주세요.' }, 400);
  }

  try {
    if (!ffmpegPath) {
      return json({ error: '서버에서 FFmpeg를 찾지 못했어요.' }, 500);
    }

    const yt = await Innertube.create();
    const info = await yt.getBasicInfo(id);

    const title = safeName(
      info.basic_info?.title || `YouTube-${id}`
    );

    // youtubei.js provides a deciphered streaming format. Using the
    // library's streaming helper avoids manually handling player state.
    const format = await yt.getStreamingData(id, {
      type: 'audio',
      quality: 'best'
    });

    if (!format) {
      return json({ error: '오디오 스트림을 찾지 못했어요.' }, 404);
    }

    const streamUrl =
      format.url || await format.decipher(yt.session.player);

    if (!streamUrl) {
      return json({ error: '오디오 스트림 주소를 얻지 못했어요.' }, 502);
    }

    // YouTube media endpoints can reject a request without a browser-like
    // User-Agent / Referer.
    const upstream = await fetch(streamUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
        'Referer': 'https://www.youtube.com/'
      }
    });

    if (!upstream.ok || !upstream.body) {
      return json(
        { error: `YouTube 오디오를 가져오지 못했어요. (HTTP ${upstream.status})` },
        502
      );
    }

    // IMPORTANT: child_process.spawn(command, args, options)
    // The previous package passed { args: [...] } as the second argument,
    // which prevents FFmpeg from starting correctly in Node.
    const ff = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-vn',
        '-codec:a',
        'libmp3lame',
        '-q:a',
        '2',
        '-f',
        'mp3',
        'pipe:1'
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const pump = (async () => {
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!ff.stdin.write(Buffer.from(value))) {
            await new Promise(resolve => ff.stdin.once('drain', resolve));
          }
        }
      } finally {
        ff.stdin.end();
      }
    })();

    const output = [];
    for await (const chunk of ff.stdout) {
      output.push(Buffer.from(chunk));
    }

    let pumpError = null;
    try {
      await pump;
    } catch (e) {
      pumpError = e;
      try { ff.stdin.destroy(); } catch {}
    }

    const [code, signal] = await new Promise(resolve => {
      ff.once('close', (exitCode, exitSignal) =>
        resolve([exitCode, exitSignal])
      );
    });

    if (pumpError) {
      console.error('YouTube stream pump error:', pumpError);
      return json({ error: 'YouTube 오디오 스트림을 읽는 중 오류가 발생했어요.' }, 502);
    }

    if (code !== 0) {
      const errText = await readProcessError(ff);
      console.error('FFmpeg failed:', code, signal, errText);
      return json({
        error: 'MP3 변환 중 오류가 발생했어요.',
        detail: errText ? errText.slice(-500) : undefined
      }, 500);
    }

    const out = Buffer.concat(output);
    if (!out.length) {
      return json({ error: '변환 결과가 비어 있어요.' }, 500);
    }

    return new Response(out, {
      status: 200,
      headers: {
        'content-type': 'audio/mpeg',
        'content-length': String(out.length),
        'content-disposition': `attachment; filename="${title}.mp3"`,
        'cache-control': 'no-store'
      }
    });
  } catch (e) {
    console.error('youtube-to-mp3 error:', e);
    return json({
      error: e?.message
        ? `YouTube 변환에 실패했어요: ${String(e.message).slice(0, 300)}`
        : 'YouTube 변환에 실패했어요.'
    }, 500);
  }
};
