import fs from "fs-extra"
import type { IncomingMessage } from "http"
import type { Headers, Options } from "got"
import type { GatsbyCache } from "gatsby"

// keeping the I for backward compatibility
export type IFetchRemoteFileOptions = {
  url: string
  auth?: {
    htaccess_pass?: string
    htaccess_user?: string
  }
  httpHeaders?: Headers
  ext?: string
  name?: string
  cacheKey?: string
} & (
  | {
      directory: string
      cache?: never
    }
  | {
      directory?: never
      cache: GatsbyCache
    }
)

const STALL_RETRY_LIMIT = process.env.GATSBY_STALL_RETRY_LIMIT
  ? parseInt(process.env.GATSBY_STALL_RETRY_LIMIT, 10)
  : 3
const STALL_TIMEOUT = process.env.GATSBY_STALL_TIMEOUT
  ? parseInt(process.env.GATSBY_STALL_TIMEOUT, 10)
  : 30000

const CONNECTION_TIMEOUT = process.env.GATSBY_CONNECTION_TIMEOUT
  ? parseInt(process.env.GATSBY_CONNECTION_TIMEOUT, 10)
  : 30000

const INCOMPLETE_RETRY_LIMIT = process.env.GATSBY_INCOMPLETE_RETRY_LIMIT
  ? parseInt(process.env.GATSBY_INCOMPLETE_RETRY_LIMIT, 10)
  : 3

// jest doesn't allow us to run all timings infinitely, so we set it 0  in tests
const BACKOFF_TIME = process.env.NODE_ENV === `test` ? 0 : 1000

function range(start: number, end: number): Array<number> {
  return Array(end - start)
    .fill(null)
    .map((_, i) => start + i)
}

// Based on the defaults of https://github.com/JustinBeckwith/retry-axios
const STATUS_CODES_TO_RETRY = [...range(100, 200), 429, ...range(500, 600)]
const ERROR_CODES_TO_RETRY = [
  `ETIMEDOUT`,
  `ECONNRESET`,
  `EADDRINUSE`,
  `ECONNREFUSED`,
  `EPIPE`,
  `ENOTFOUND`,
  `ENETUNREACH`,
  `EAI_AGAIN`,
  `ERR_NON_2XX_3XX_RESPONSE`,
  `ERR_GOT_REQUEST_ERROR`,
]

/**
 * requestRemoteNode
 * --
 * Download the requested file
 *
 * @param  {String}   url
 * @param  {Headers}  headers
 * @param  {String}   tmpFilename
 * @param  {Object}   httpOptions
 * @param  {number}   attempt
 * @return {Promise<Object>}  Resolves with the [http Result Object]{@link https://nodejs.org/api/http.html#http_class_http_serverresponse}
 */
export async function requestRemoteNode(
  url: string | URL,
  headers: Headers,
  tmpFilename: string,
  httpOptions?: Options,
  attempt: number = 1
): Promise<IncomingMessage> {
  // TODO(v5): use dynamic import syntax - it's currently blocked because older v4 versions have V8-compile-cache
  // const { default: got, RequestError } = await import(`got`)
  const { default: got, RequestError } = require(`got`)

  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout
    const fsWriteStream = fs.createWriteStream(tmpFilename)
    fsWriteStream.on(`error`, (error: unknown) => {
      if (timeout) {
        clearTimeout(timeout)
      }

      reject(error)
    })

    // Called if we stall for 30s without receiving any data
    const handleTimeout = async (): Promise<void> => {
      fsWriteStream.close()
      await fs.remove(tmpFilename)

      if (attempt < STALL_RETRY_LIMIT) {
        // Retry by calling ourself recursively
        resolve(
          requestRemoteNode(url, headers, tmpFilename, httpOptions, attempt + 1)
        )
      } else {
        // TODO move to new Error type
        // eslint-disable-next-line prefer-promise-reject-errors
        reject(`Failed to download ${url} after ${STALL_RETRY_LIMIT} attempts`)
      }
    }

    const resetTimeout = (): void => {
      if (timeout) {
        clearTimeout(timeout)
      }
      timeout = setTimeout(handleTimeout, STALL_TIMEOUT)
    }
    const responseStream = got.stream(url, {
      headers,
      timeout: {
        send: CONNECTION_TIMEOUT, // https://github.com/sindresorhus/got#timeout
      },
      ...httpOptions,
      isStream: true,
    })

    let haveAllBytesBeenWritten = false
    // Fixes a bug in latest got where progress.total gets reset when stream ends, even if it wasn't complete.
    let totalSize: number | null = null
    responseStream.on(`downloadProgress`, progress => {
      // reset the timeout on each progress event to make sure large files don't timeout
      resetTimeout()

      if (
        progress.total != null &&
        (!totalSize || totalSize < progress.total)
      ) {
        totalSize = progress.total
      }

      if (progress.transferred === totalSize || totalSize === null) {
        haveAllBytesBeenWritten = true
      }
    })

    responseStream.pipe(fsWriteStream)

    // If there's a 400/500 response or other error.
    // it will trigger a finish event on fsWriteStream
    responseStream.on(`error`, async error => {
      if (timeout) {
        clearTimeout(timeout)
      }

      fsWriteStream.close()
      await fs.remove(tmpFilename)

      if (!(error instanceof RequestError)) {
        return reject(error)
      }

      // This is a replacement for the stream retry logic of got
      // till we can update all got instances to v12
      // https://github.com/sindresorhus/got/blob/main/documentation/7-retry.md
      // https://github.com/sindresorhus/got/blob/main/documentation/3-streams.md#retry
      const statusCode = error.response?.statusCode
      const errorCode = error.code || error.message // got gives error.code, but msw/node returns the error codes in the message only

      if (
        // HTTP STATUS CODE ERRORS
        (statusCode && STATUS_CODES_TO_RETRY.includes(statusCode)) ||
        // GENERAL NETWORK ERRORS
        (errorCode && ERROR_CODES_TO_RETRY.includes(errorCode))
      ) {
        if (attempt < INCOMPLETE_RETRY_LIMIT) {
          setTimeout(() => {
            resolve(
              requestRemoteNode(
                url,
                headers,
                tmpFilename,
                httpOptions,
                attempt + 1
              )
            )
          }, BACKOFF_TIME * attempt)

          return undefined
        }
        // Throw user friendly error
        error.message = [
          `Unable to fetch:`,
          url,
          `---`,
          `Reason: ${error.message}`,
          `---`,
        ].join(`\n`)

        // Gather details about what went wrong from the error object and the request
        const details = Object.entries({
          attempt,
          method: error.options?.method,
          errorCode: error.code,
          responseStatusCode: error.response?.statusCode,
          responseStatusMessage: error.response?.statusMessage,
          requestHeaders: error.options?.headers,
          responseHeaders: error.response?.headers,
        })
          // Remove undefined values from the details to keep it clean
          .reduce((a, [k, v]) => (v === undefined ? a : ((a[k] = v), a)), {})

        if (Object.keys(details).length) {
          error.message = [
            error.message,
            `Fetch details:`,
            JSON.stringify(details, null, 2),
            `---`,
          ].join(`\n`)
        }
      }

      return reject(error)
    })

    responseStream.on(`response`, response => {
      resetTimeout()

      fsWriteStream.once(`finish`, async () => {
        if (timeout) {
          clearTimeout(timeout)
        }

        // We have an incomplete download
        if (!haveAllBytesBeenWritten) {
          await fs.remove(tmpFilename)

          if (attempt < INCOMPLETE_RETRY_LIMIT) {
            // let's give node time to remove the file
            setImmediate(() =>
              resolve(
                requestRemoteNode(
                  url,
                  headers,
                  tmpFilename,
                  httpOptions,
                  attempt + 1
                )
              )
            )

            return undefined
          } else {
            // TODO move to new Error type
            // eslint-disable-next-line prefer-promise-reject-errors
            return reject(
              `Failed to download ${url} after ${INCOMPLETE_RETRY_LIMIT} attempts`
            )
          }
        }

        return resolve(response)
      })
    })
  })
}
