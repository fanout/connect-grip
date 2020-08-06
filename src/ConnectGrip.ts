import { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from "http";
import * as CallableInstance from "callable-instance";

import {
    GripInstruct,
    IGripConfig,
    IPublisherConfig,
    PrefixedPublisher,
    Publisher,
    WebSocketContext,
    decodeWebSocketEvents,
    encodeWebSocketEvents,
    validateSig,
} from "@fanoutio/grip";

import IConnectGripConfig from "./IConnectGripConfig";
import IRequestGrip from "./IRequestGrip";

import { ConnectGripApiResponse } from "./ConnectGripApiResponse";
import { ConnectGripApiRequest } from "./ConnectGripApiRequest";
import IResponseGrip from "./IResponseGrip";
import GripInstructNotAvailableException from "./data/GripInstructNotAvailableException";
import GripInstructAlreadyStartedException from "./data/GripInstructAlreadyStartedException";

const CONTENT_TYPE_WEBSOCKET_EVENTS = 'application/websocket-events';

function flattenHeader(value: undefined | string | string[]) {
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
}

// @ts-ignore
export default class ConnectGrip extends CallableInstance<[IncomingMessage, ServerResponse, Function], void> {
    gripProxies?: IGripConfig[];
    pubServers?: IPublisherConfig[];
    prefix: string = '';
    isGripProxyRequired: boolean = false;
    _publisher?: PrefixedPublisher;

    constructor(config?: IConnectGripConfig) {
        super('exec');
        this.applyConfig(config);
    }

    applyConfig(config: IConnectGripConfig = {}) {

        const { gripProxies, gripPubServers, gripProxyRequired = false, gripPrefix = '' } = config;

        this.gripProxies = gripProxies;
        this.pubServers = gripPubServers;
        this.isGripProxyRequired = gripProxyRequired;
        this.prefix = gripPrefix;

    }

    getPublisher(): PrefixedPublisher {
        if (this._publisher == null) {
            const publisher = new Publisher();
            if (this.gripProxies != null) {
                publisher.applyConfig(this.gripProxies);
            }
            if (this.pubServers != null) {
                publisher.applyConfig(this.pubServers);
            }
            this._publisher = publisher.buildPrefixedPublisher(this.prefix) as PrefixedPublisher;
        }
        return this._publisher;
    }

    exec(req: IncomingMessage, res: ServerResponse, fn: Function) {

        this.handle(req as ConnectGripApiRequest, res as ConnectGripApiResponse)
            .then(() => fn())
            .catch(err => fn(err));

    }

    async handle(req: ConnectGripApiRequest, res: ConnectGripApiResponse) {

        // ## Set Request GRIP values

        const gripSigHeader = flattenHeader(req.headers['grip-sig']);

        let isProxied = false;
        let isSigned = false;
        if (gripSigHeader !== undefined && Array.isArray(this.gripProxies) && this.gripProxies.length > 0) {
            if (this.gripProxies.every(proxy => proxy.key)) {
                // If all proxies have keys, then only consider the request
                // signed if at least one of them has signed it
                if (this.gripProxies.some(proxy => validateSig(gripSigHeader, proxy.key))) {
                    isProxied = true;
                    isSigned = true;
                }
            } else {
                isProxied = true;
            }
        }

        if (!isProxied && this.isGripProxyRequired) {
            // If we require a Grip proxy but we detect there is
            // not one, we needs to fail now
            res.statusCode = 501;
            res.end('Not Implemented.\n');
            return;
        }

        let contentTypeHeader = flattenHeader(req.headers['content-type']);
        if (contentTypeHeader != null) {
            const at = contentTypeHeader.indexOf(';');
            if (at >= 0) {
                contentTypeHeader = contentTypeHeader.substring(0, at);
            }
        }

        const acceptTypesHeader = flattenHeader(req.headers['accept']);
        const acceptTypes = acceptTypesHeader?.split(',')
            .map(item => item.trim());

        let wsContext: WebSocketContext | null = null;

        if (req.method === 'POST' && (
            contentTypeHeader === CONTENT_TYPE_WEBSOCKET_EVENTS ||
            acceptTypes?.includes(CONTENT_TYPE_WEBSOCKET_EVENTS)
        )) {
            const cid = flattenHeader(req.headers['connection-id']);
            if (cid == null) {
                res.statusCode = 400;
                res.end('WebSocket event missing connection-id header.\n');
                return;
            }

            // Handle meta keys
            const meta = {};
            for (const [key, value] of Object.entries(req.headers)) {
                const lKey = key.toLowerCase();
                if (lKey.startsWith('meta-')) {
                    meta[lKey.substring(5)] = value;
                }
            }

            if (req.body == null) {
                req.body = await new Promise(resolve => {
                    const bodySegments: any[] = [];
                    req.on('data', (chunk) => {
                        bodySegments.push(chunk);
                    });
                    req.on('end', () => {
                        const bodyBuffer = Buffer.concat(bodySegments);
                        resolve(bodyBuffer);
                    });
                });
            }

            let events = null;
            try {
                events = decodeWebSocketEvents(req.body!);
            } catch (err) {
                res.statusCode = 400;
                res.end('Error parsing WebSocket events.\n');
                return;
            }
            wsContext = new WebSocketContext(cid, meta, events, this.prefix);
        }

        const requestGrip: IRequestGrip = {
            isProxied,
            isSigned,
            wsContext,
        };
        Object.assign(req, { grip: requestGrip });

        // ## Set response GRIP values

        let startInstruct: () => GripInstruct = () => { throw new GripInstructNotAvailableException(); };
        if (isProxied) {

            let gripInstruct: GripInstruct | null = null;
            startInstruct = () => {
                if (gripInstruct != null) {
                    throw new GripInstructAlreadyStartedException();
                }
                gripInstruct = new GripInstruct();
                return gripInstruct;
            }

            // Monkey-patch methods on response

            const resWriteHead = res.writeHead;
            // @ts-ignore
            res.writeHead = (statusCode: number, reason?: string, obj?: OutgoingHttpHeaders) => {

                if (typeof reason === 'string') {
                    // assume this was called like this:
                    // writeHead(statusCode, reasonPhrase[, headers])
                } else {
                    // this was called like this:
                    // writeHead(statusCode[, headers])
                    obj = reason;
                }

                if (statusCode === 200 && wsContext != null) {
                    obj = Object.assign({}, obj, wsContext.toHeaders());
                }

                if (gripInstruct != null) {
                    obj = Object.assign({}, obj, gripInstruct.toHeaders());
                }

                if (typeof reason === 'string') {
                    resWriteHead.call(res, statusCode, reason, obj);
                } else {
                    resWriteHead.call(res, statusCode, obj);
                }
            };

            const resEnd = res.end;
            // @ts-ignore
            res.end = (chunk: any, encoding: BufferEncoding, callback: Function) => {

                if (res.statusCode === 200 && wsContext != null) {

                    const events = wsContext.getOutgoingEvents();
                    res.write(encodeWebSocketEvents(events));

                }

                resEnd.call(res, chunk, encoding, callback);
            }

        }

        const responseGrip: IResponseGrip = {
            startInstruct,
        };
        Object.assign(res, { grip: responseGrip });

    }
}



