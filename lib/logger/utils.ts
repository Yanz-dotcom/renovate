import { Stream } from 'stream';
import bunyan from 'bunyan';
import fs from 'fs-extra';
import { clone } from '../util/clone';
import { HttpError } from '../util/http/types';
import { redactedFields, sanitize } from '../util/sanitize';
import type { BunyanRecord, BunyanStream } from './types';

const excludeProps = ['pid', 'time', 'v', 'hostname'];

export class ProblemStream extends Stream {
  private _problems: BunyanRecord[] = [];

  readable: boolean;

  writable: boolean;

  constructor() {
    super();
    this.readable = false;
    this.writable = true;
  }

  write(data: BunyanRecord): boolean {
    const problem = { ...data };
    for (const prop of excludeProps) {
      delete problem[prop];
    }
    this._problems.push(problem);
    return true;
  }

  getProblems(): BunyanRecord[] {
    return this._problems;
  }

  clearProblems(): void {
    this._problems = [];
  }
}
const templateFields = ['prBody'];
const contentFields = [
  'content',
  'contents',
  'packageLockParsed',
  'yarnLockParsed',
];

export default function prepareError(err: Error): Record<string, unknown> {
  const response: Record<string, unknown> = {
    ...err,
  };

  // Required as message is non-enumerable
  if (!response.message && err.message) {
    response.message = err.message;
  }

  // Required as stack is non-enumerable
  if (!response.stack && err.stack) {
    response.stack = err.stack;
  }

  // handle got error
  if (err instanceof HttpError) {
    const options: Record<string, unknown> = {
      headers: clone(err.options.headers),
      url: err.options.url?.toString(),
      hostType: err.options.context.hostType,
    };
    response.options = options;

    for (const k of ['username', 'password', 'method', 'http2']) {
      options[k] = err.options[k];
    }

    // istanbul ignore else
    if (err.response) {
      response.response = {
        statusCode: err.response?.statusCode,
        statusMessage: err.response?.statusMessage,
        body: clone(err.response.body),
        headers: clone(err.response.headers),
        httpVersion: err.response.httpVersion,
      };
    }
  }

  return response;
}

export function sanitizeValue(_value: unknown, seen = new WeakMap()): any {
  let value = _value;
  if (Array.isArray(value)) {
    const length = value.length;
    const arrayResult = Array(length);
    seen.set(value, arrayResult);
    for (let idx = 0; idx < length; idx += 1) {
      const val = value[idx];
      arrayResult[idx] = seen.has(val)
        ? seen.get(val)
        : sanitizeValue(val, seen);
    }
    return arrayResult;
  }

  if (value instanceof Buffer) {
    return '[content]';
  }

  if (value instanceof Error) {
    value = prepareError(value);
  }

  const valueType = typeof value;

  if (value && valueType !== 'function' && valueType === 'object') {
    if (value instanceof Date) {
      return value;
    }

    const objectResult: Record<string, any> = {};
    seen.set(value as any, objectResult);
    for (const [key, val] of Object.entries<any>(value)) {
      let curValue: any;
      if (!val) {
        curValue = val;
      } else if (redactedFields.includes(key)) {
        curValue = '***********';
      } else if (contentFields.includes(key)) {
        curValue = '[content]';
      } else if (templateFields.includes(key)) {
        curValue = '[Template]';
      } else if (key === 'secrets') {
        curValue = {};
        Object.keys(val).forEach((secretKey) => {
          curValue[secretKey] = '***********';
        });
      } else {
        curValue = seen.has(val) ? seen.get(val) : sanitizeValue(val, seen);
      }

      objectResult[key] = curValue;
    }
    return objectResult;
  }

  return valueType === 'string' ? sanitize(value as string) : value;
}

export function withSanitizer(streamConfig: bunyan.Stream): bunyan.Stream {
  if (streamConfig.type === 'rotating-file') {
    throw new Error("Rotating files aren't supported");
  }

  const stream = streamConfig.stream as BunyanStream;
  if (stream?.writable) {
    const write = (chunk: BunyanRecord, enc, cb): void => {
      const raw = sanitizeValue(chunk);
      const result =
        streamConfig.type === 'raw'
          ? raw
          : JSON.stringify(raw, bunyan.safeCycles()).replace(/\n?$/, '\n'); // TODO #12070
      stream.write(result, enc, cb);
    };

    return {
      ...streamConfig,
      type: 'raw',
      stream: { write },
    } as bunyan.Stream;
  }

  if (streamConfig.path) {
    const fileStream = fs.createWriteStream(streamConfig.path, {
      flags: 'a',
      encoding: 'utf8',
    });

    return withSanitizer({ ...streamConfig, stream: fileStream });
  }

  throw new Error("Missing 'stream' or 'path' for bunyan stream");
}
