// listen(0) 的端口来自系统动态端口范围。本机这类 Windows 环境可能配置为 1024 起，
// 于是偶尔会分到 fetch 规范禁止的端口（如 6000、6667、10080），fetch 随即以 "bad port" 失败。
// 这里遇到这类端口就关掉重开。

// https://fetch.spec.whatwg.org/#bad-port
const FETCH_BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512,
  513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995,
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

export const isFetchBadPort = (port) => FETCH_BAD_PORTS.has(port);

/** server.listen(0, host)，保证得到的端口可被 fetch 访问；返回端口号。 */
export async function listenFetchable(server, host = '127.0.0.1') {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const { port } = server.address();
    if (!isFetchBadPort(port)) return port;
    await new Promise((r) => server.close(r));
  }
  throw new Error('could not get a fetch-allowed port');
}
