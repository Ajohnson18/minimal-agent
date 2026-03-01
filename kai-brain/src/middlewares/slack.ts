/**
 * Slack Middleware
 * Adapted from somethings-api/src/middlewares/slack-verify.ts
 */
import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { createLogger } from '../lib/logger.js';

const log = createLogger('slack', { component: 'slack-signature-middleware' });

/**
 * Verify Slack request signature using HMAC-SHA256
 */
export function verifySlackSignature(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!signingSecret) {
    log.error('SLACK_SIGNING_SECRET not configured');
    res.status(500).send('Server configuration error');
    return;
  }

  const signature = req.headers['x-slack-signature'] as string;
  const timestamp = req.headers['x-slack-request-timestamp'] as string;

  if (!signature || !timestamp) {
    res.status(401).send('Missing Slack signature headers');
    return;
  }

  // Check timestamp is within 5 minutes
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp) < fiveMinutesAgo) {
    res.status(401).send('Request timestamp too old');
    return;
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    log.warn('No raw body found for signature verification');
    res.status(401).send('Missing raw body');
    return;
  }

  const sigBaseString = `v0:${timestamp}:${rawBody}`;
  const mySignature =
    'v0=' +
    crypto.createHmac('sha256', signingSecret).update(sigBaseString).digest('hex');

  try {
    if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(mySignature))) {
      next();
    } else {
      log.warn('Invalid Slack signature');
      res.status(401).send('Invalid signature');
    }
  } catch (error) {
    log.warn({ err: error }, 'Slack signature verification failed');
    res.status(401).send('Invalid signature');
  }
}

/**
 * Handle Slack URL verification challenge
 */
export function handleSlackChallenge(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (req.body?.type === 'url_verification') {
    res.send({ challenge: req.body.challenge });
    return;
  }
  next();
}
