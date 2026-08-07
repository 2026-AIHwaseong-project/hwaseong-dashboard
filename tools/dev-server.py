#!/usr/bin/env python3
"""개발용 정적 파일 서버 — 브라우저 캐시를 끕니다.

`python3 -m http.server` 는 캐시 관련 헤더를 보내지 않아, 브라우저가
예전 .js / .css 를 계속 쓰는 일이 생깁니다.
(코드를 고쳤는데 화면이 안 바뀌거나, 없는 함수라며 오류가 나는 원인)

이 서버는 응답마다 no-store 를 붙여 매번 새로 받아가게 합니다.

    python3 tools/dev-server.py          # 5500 포트
    python3 tools/dev-server.py 8080     # 포트 지정

주의: 개발·시연용입니다. 실제 배포에는 쓰지 마세요.
"""

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 접속 로그 생략


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5500
    server = ThreadingHTTPServer(('0.0.0.0', port), NoCacheHandler)
    print('http://0.0.0.0:%d 에서 서비스 중 (캐시 없음). 종료는 Ctrl+C' % port, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
