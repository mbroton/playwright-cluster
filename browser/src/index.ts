import { chromium, type BrowserServer } from 'playwright';
import { createClient, type RedisClientType } from 'redis';
import { loadConfig } from './config.js';
import type { WorkerConfig } from './config.js';
import { Logger } from './logger.js';


interface WorkerMetadata {
    id: string;
    endpoint: string;
    status: 'starting' | 'available' | 'recycling' | 'shutting-down';
    startedAt: string; // ISO 8601
    lastHeartbeat: string;
}


class BrowserWorker {
    private workerId: string;
    private config: WorkerConfig;
    private redis: RedisClientType;
    private logger: Logger;
    private browserServer: BrowserServer | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private isShuttingDown: boolean = false;
    private redisKey: string;

    constructor() {
        this.workerId = crypto.randomUUID();
        this.config = loadConfig();
        this.logger = new Logger(this.workerId, this.config.logging.level);
        this.redis = createClient({ url: this.config.redis.url });
        this.redisKey = `worker:${this.workerId}`;
    }

    private formatError(error: unknown): Record<string, any> {
        if (error instanceof Error) {
            return { message: error.message, stack: error.stack };
        }
        return { message: String(error) };
    }

    private async connectToRedis(): Promise<void> {
        let attempts = 0;
        this.logger.info('Connecting to Redis...', { url: this.config.redis.url });
        while (attempts < this.config.redis.retryAttempts) {
            try {
                await Promise.race([
                    this.redis.connect(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Redis connection timed out')), 2000)
                    )
                ]);

                await this.redis.ping();

                this.logger.info('Successfully connected to Redis', { url: this.config.redis.url });
                return;
            } catch (error) {
                attempts++;
                this.logger.warn('Redis connection attempt failed', {
                    attempt: attempts,
                    maxAttempts: this.config.redis.retryAttempts,
                    error: this.formatError(error)
                });
                if (attempts >= this.config.redis.retryAttempts) {
                    throw new Error(`Failed to connect to Redis after ${attempts} attempts.`);
                }
                await new Promise(resolve => setTimeout(resolve, this.config.redis.retryDelay));
            }
        }
    }

    public async start(): Promise<void> {
        this.logger.info('Starting browser worker...', { config: this.config });

        try {
            await this.connectToRedis();

            this.browserServer = await chromium.launchServer({
                port: this.config.server.port,
                headless: this.config.server.headless,
                wsPath: `/playwright/${this.workerId}`,
            });

            const wsEndpoint = this.browserServer.wsEndpoint();
            let internalEndpoint = wsEndpoint;
            if (this.config.server.privateHostname) {
                internalEndpoint = wsEndpoint.replace(/ws:\/\/127\.0\.0\.1|ws:\/\/localhost/, `ws://${this.config.server.privateHostname}`);
            }

            this.logger.info('Browser server launched', { endpoint: internalEndpoint });

            await this.register(internalEndpoint);

            this.startHeartbeat();

            process.on('SIGINT', () => this.gracefulShutdown('SIGINT'));
            process.on('SIGTERM', () => this.gracefulShutdown('SIGTERM'));

            this.logger.info('Browser worker is running and registered.');

        } catch (error) {
            this.logger.error('Failed to start browser worker', { error: this.formatError(error) });
            await this.cleanupAndExit(1);
        }
    }

    private async register(endpoint: string): Promise<void> {
        const metadata: WorkerMetadata = {
            id: this.workerId,
            endpoint,
            status: 'available',
            startedAt: new Date().toISOString(),
            lastHeartbeat: new Date().toISOString(),
        };

        await this.redis.hSet(this.redisKey, metadata as unknown as Record<string, string>);
        await this.redis.expire(this.redisKey, this.config.redis.keyTtl);

        this.logger.info('Worker registered in Redis', { key: this.redisKey, endpoint });
    }

    private startHeartbeat(): void {
        this.heartbeatTimer = setInterval(
            () => this.performHeartbeat(),
            this.config.server.heartbeatInterval
        );
        this.logger.info('Heartbeat started', { intervalMs: this.config.server.heartbeatInterval });
    }

    private async performHeartbeat(): Promise<void> {
        if (this.isShuttingDown) return;

        try {
            const status = await this.redis.hGet(this.redisKey, 'status');

            if (status === 'recycling') {
                this.logger.info('Recycle command received from Hub. Initiating shutdown.');
                await this.gracefulShutdown('recycle_command');
                return;
            }

            await this.redis.hSet(this.redisKey, 'lastHeartbeat', new Date().toISOString());
            await this.redis.expire(this.redisKey, this.config.redis.keyTtl);

            this.logger.info('Heartbeat sent', { key: this.redisKey });

        } catch (error) {
            this.logger.error('Failed to perform heartbeat', { error: this.formatError(error) });
            await this.gracefulShutdown('heartbeat_error');
        }
    }

    private async gracefulShutdown(initiator: string): Promise<void> {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        this.logger.info('Initiating graceful shutdown...', { initiator });

        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        try {
            this.logger.info('Updating worker status to "shutting-down" in Redis.');
            await this.redis.hSet(this.redisKey, 'status', 'shutting-down');
            await this.redis.expire(this.redisKey, 10);
        } catch (error) {
            this.logger.error('Failed to update worker status during shutdown.', { error: this.formatError(error) });
        }

        if (this.browserServer) {
            this.logger.info('Closing the browser server.');
            await this.browserServer.close();
            this.logger.info('Browser server closed.');
        }

        await this.cleanupAndExit(0);
    }

    private async cleanupAndExit(exitCode: number): Promise<void> {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }

        try {
            await this.redis.del(this.redisKey);
            this.logger.info('Worker key removed from Redis.');
        } catch (error) {
            this.logger.error('Failed to remove worker key from Redis during cleanup.', { error: this.formatError(error) });
        }

        await this.redis.quit();
        this.logger.info('Redis connection closed. Exiting.', { exitCode });
        process.exit(exitCode);
    }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
    const worker = new BrowserWorker();
    worker.start().catch(async (error) => {
        console.error(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'error',
            message: 'Caught unhandled exception during startup. Exiting.',
            error: error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) }
        }));
        process.exit(1);
    });
} 