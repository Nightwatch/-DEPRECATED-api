import { createConnection } from 'typeorm'
import * as express from 'express'
import * as path from 'path'
import { init } from './utilities'
import { Logger } from '@nightwatch/util'
import { InversifyExpressServer } from 'inversify-express-utils'
import * as bodyParser from 'body-parser'
import { config } from './config'
import * as helmet from 'helmet'
import * as morgan from 'morgan'
import { container } from './ioc/ioc'
import * as cors from 'cors'
import * as compression from 'compression'
import * as expressStatusMonitor from 'express-status-monitor'
import * as errorHandler from 'errorhandler'
import * as jwt from 'express-jwt'
import * as jsonwebtoken from 'jsonwebtoken'
import * as RateLimit from 'express-rate-limit'
import * as socketIo from 'socket.io'
import * as mongoMorgan from 'mongo-morgan'
import * as url from 'url'
import './ioc/loader'
const { secret, apiServerIp, debug, mongodb } = require('../api.json')

/**
 * The API server
 *
 * @class Api
 */
export class Api {
  /**
   * Creates an instance of the Api.
   * @memberof Api
   */
  constructor () {
    this.init()
  }

  /**
   * Starts the API server.
   *
   * @static
   * @returns {Api}
   * @memberof Api
   */
  static start (): Api {
    return new Api()
  }

  private init () {
    createConnection()
      .then(async () => {
        this.startServer()
      })
      .catch(err => Logger.error(err))
  }

  private startServer () {
    const server = new InversifyExpressServer(container)

    const limiter = new RateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 150,
      delayMs: 0,
      skip: (request, response) => {
        if (apiServerIp === request.ip) {
          return true
        }

        return false
      }
    })

    server.setConfig(app => {
      app.enable('trust proxy')
      app.use(limiter)
      app.use(
        bodyParser.urlencoded({
          extended: true
        })
      )
      app.use(bodyParser.json())
      app.use(helmet())
      app.use(cors())
      app.use(compression())
      app.use(expressStatusMonitor())
      app.use(
        morgan('tiny', {
          stream: {
            write: message => Logger.info(message.trim())
          }
        })
      )
      app.use(
        mongoMorgan(
          mongodb,
          function (tokens: any, req: express.Request, res: express.Response) {
            const filteredReq = req
            filteredReq.query = ''
            filteredReq.originalUrl = url.parse(filteredReq.url).pathname!
            return [
              tokens.method(filteredReq, res),
              tokens.url(filteredReq, res),
              tokens.status(filteredReq, res),
              tokens.res(filteredReq, res, 'content-length'),
              '-',
              tokens['response-time'](filteredReq, res),
              'ms'
            ].join(' ')
          },
          {
            collection: 'logs'
          }
        )
      )
      app.use(
        jwt({
          secret,
          getToken: req => {
            // Special routes I don't want the average user to see :)
            // TODO: Create route-based authentication, decorators would be nice.
            const blacklistedRoutes = [ 'keys' ]

            if (
              req.method.toLowerCase() === 'get' &&
              !blacklistedRoutes.some(route => req.path.toLowerCase().includes(route))
            ) {
              // *Hacky* approach to bypass request validation for GET requests, since I want anyone to be able to see the data.
              return jsonwebtoken.sign('GET', secret)
            }

            if (req.headers.authorization && (req.headers.authorization as string).split(' ')[0] === 'Bearer') {
              return (req.headers.authorization as string).split(' ')[1]
            } else if (req.query && req.query.token) {
              return req.query.token
            }
            return null
          }
        })
      )

      app.use('/api', express.static(path.join(__dirname, '../public')))

      app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
        console.error(err)
        res.status(500).send('Oof! Something went wrong.')
      })

      if (debug === true) {
        app.use(errorHandler())
      }
    })

    const app = server.build()
    const port = process.env.PORT || config.port
    const instance = app.listen(port)

    const io = socketIo.listen(instance)
    init(io)

    Logger.info(`Express server listening on port ${port}`)
  }
}
