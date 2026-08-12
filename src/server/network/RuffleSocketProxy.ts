import * as http from 'http';
import * as net from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import { isWebAccessAuthorized } from '../integrations/WebAccessGate';

export class RuffleSocketProxy {
    private static readonly MAX_CONNECTIONS = 32;
    private static readonly IDLE_TIMEOUT_MS = 120_000;

    private readonly webSocketServer = new WebSocketServer({
        noServer: true,
        maxPayload: 2 * 1024 * 1024,
        perMessageDeflate: false
    });
    private server: http.Server | null = null;
    private activeConnections = 0;

    constructor(
        private readonly listenPort: number,
        private readonly listenHost: string,
        private readonly targetPort: number,
        private readonly targetHost: string
    ) {}

    public start(): void {
        if (this.server) {
            return;
        }

        this.server = http.createServer((_req, res) => {
            res.writeHead(426, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end('WebSocket upgrade required.');
        });

        this.server.on('upgrade', (request, socket, head) => {
            const requestUrl = new URL(request.url ?? '/', 'http://localhost');
            if (requestUrl.pathname !== '/game-socket') {
                socket.destroy();
                return;
            }

            if (!isWebAccessAuthorized(request.headers.cookie)) {
                socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
                socket.destroy();
                return;
            }

            if (this.activeConnections >= RuffleSocketProxy.MAX_CONNECTIONS) {
                socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
                socket.destroy();
                return;
            }

            this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
                this.webSocketServer.emit('connection', webSocket, request);
            });
        });

        this.webSocketServer.on('connection', (webSocket) => {
            this.bridgeConnection(webSocket);
        });

        this.server.listen(this.listenPort, this.listenHost, () => {
            console.log(
                `[RuffleSocketProxy] Listening on ${this.listenHost}:${this.listenPort} -> ${this.targetHost}:${this.targetPort}`
            );
        });

        this.server.on('error', (error) => {
            console.error('[RuffleSocketProxy] Server error:', error);
        });
    }

    private bridgeConnection(webSocket: WebSocket): void {
        const tcpSocket = net.createConnection({
            host: this.targetHost,
            port: this.targetPort
        });
        const useBase64 = webSocket.protocol === 'base64';
        let connectionCounted = true;
        this.activeConnections += 1;

        tcpSocket.setNoDelay(true);
        tcpSocket.setTimeout(RuffleSocketProxy.IDLE_TIMEOUT_MS);

        webSocket.on('message', (data, isBinary) => {
            if (tcpSocket.destroyed) {
                return;
            }
            if (useBase64 && !isBinary) {
                tcpSocket.write(Buffer.from(data.toString(), 'base64'));
                return;
            }
            tcpSocket.write(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        });

        tcpSocket.on('data', (data) => {
            if (webSocket.readyState !== WebSocket.OPEN) {
                return;
            }
            webSocket.send(useBase64 ? data.toString('base64') : data, { binary: !useBase64 });
        });

        const closeTcp = () => {
            if (!tcpSocket.destroyed) {
                tcpSocket.destroy();
            }
        };
        const closeWebSocket = () => {
            if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) {
                webSocket.close();
            }
        };
        const releaseConnection = () => {
            if (connectionCounted) {
                connectionCounted = false;
                this.activeConnections = Math.max(0, this.activeConnections - 1);
            }
        };

        webSocket.on('close', () => {
            releaseConnection();
            closeTcp();
        });
        webSocket.on('error', closeTcp);
        tcpSocket.on('timeout', () => {
            closeTcp();
            closeWebSocket();
        });
        tcpSocket.on('close', () => {
            releaseConnection();
            closeWebSocket();
        });
        tcpSocket.on('error', (error) => {
            console.warn(`[RuffleSocketProxy] TCP bridge error: ${error.message}`);
            closeWebSocket();
        });
    }

    public async stop(): Promise<void> {
        for (const client of this.webSocketServer.clients) {
            client.terminate();
        }

        if (!this.server?.listening) {
            this.server = null;
            return;
        }

        const server = this.server;
        this.server = null;
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
    }
}
