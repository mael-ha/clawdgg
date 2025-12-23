/**
 * Twitter/X Publisher
 * Handles posting tweets with threading support
 */

// Note: You'll need to install twitter-api-v2
// bun add twitter-api-v2

export interface Tweet {
  id: string;
  text: string;
}

export interface TweetOptions {
  replyTo?: string;  // Tweet ID to reply to
}

/**
 * Twitter client wrapper
 * Requires these env vars:
 * - TWITTER_API_KEY
 * - TWITTER_API_SECRET
 * - TWITTER_ACCESS_TOKEN
 * - TWITTER_ACCESS_SECRET
 */
export class TwitterClient {
  private client: any;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    // Dynamic import to avoid errors if package not installed
    const { TwitterApi } = await import('twitter-api-v2');

    const apiKey = process.env.TWITTER_API_KEY;
    const apiSecret = process.env.TWITTER_API_SECRET;
    const accessToken = process.env.TWITTER_ACCESS_TOKEN;
    const accessSecret = process.env.TWITTER_ACCESS_SECRET;

    if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
      throw new Error('Missing Twitter API credentials in environment');
    }

    this.client = new TwitterApi({
      appKey: apiKey,
      appSecret: apiSecret,
      accessToken: accessToken,
      accessSecret: accessSecret,
    });

    this.initialized = true;
  }

  /**
   * Post a single tweet
   */
  async tweet(text: string, options?: TweetOptions): Promise<Tweet> {
    await this.init();

    const payload: any = { text };

    if (options?.replyTo) {
      payload.reply = { in_reply_to_tweet_id: options.replyTo };
    }

    const result = await this.client.v2.tweet(payload);

    return {
      id: result.data.id,
      text: result.data.text,
    };
  }

  /**
   * Post a thread of tweets
   * Returns all tweet IDs in order
   */
  async thread(tweets: string[]): Promise<Tweet[]> {
    await this.init();

    const results: Tweet[] = [];
    let lastTweetId: string | undefined;

    for (const text of tweets) {
      const result = await this.tweet(text, {
        replyTo: lastTweetId,
      });
      results.push(result);
      lastTweetId = result.id;
    }

    return results;
  }

  /**
   * Reply to an existing tweet
   */
  async reply(tweetId: string, text: string): Promise<Tweet> {
    return this.tweet(text, { replyTo: tweetId });
  }
}

// Singleton instance
let twitterClient: TwitterClient | null = null;

export function getTwitterClient(): TwitterClient {
  if (!twitterClient) {
    twitterClient = new TwitterClient();
  }
  return twitterClient;
}

/**
 * Helper: Split text into tweet-sized chunks
 * Twitter limit is 280 characters
 */
export function splitIntoTweets(text: string, maxLength = 270): string[] {
  const tweets: string[] = [];
  const paragraphs = text.split('\n\n');

  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 <= maxLength) {
      current += (current ? '\n\n' : '') + para;
    } else {
      if (current) tweets.push(current);

      // Handle paragraphs that are too long
      if (para.length > maxLength) {
        const words = para.split(' ');
        current = '';
        for (const word of words) {
          if (current.length + word.length + 1 <= maxLength) {
            current += (current ? ' ' : '') + word;
          } else {
            if (current) tweets.push(current);
            current = word;
          }
        }
      } else {
        current = para;
      }
    }
  }

  if (current) tweets.push(current);

  return tweets;
}

/**
 * Dry run mode for testing
 */
export class MockTwitterClient {
  private tweetCounter = 0;

  async tweet(text: string, options?: TweetOptions): Promise<Tweet> {
    this.tweetCounter++;
    const id = `mock_${this.tweetCounter}`;

    console.log('\n--- MOCK TWEET ---');
    if (options?.replyTo) {
      console.log(`Reply to: ${options.replyTo}`);
    }
    console.log(`ID: ${id}`);
    console.log(`Text (${text.length} chars):`);
    console.log(text);
    console.log('--- END TWEET ---\n');

    return { id, text };
  }

  async thread(tweets: string[]): Promise<Tweet[]> {
    const results: Tweet[] = [];
    let lastTweetId: string | undefined;

    for (const text of tweets) {
      const result = await this.tweet(text, {
        replyTo: lastTweetId,
      });
      results.push(result);
      lastTweetId = result.id;
    }

    return results;
  }

  async reply(tweetId: string, text: string): Promise<Tweet> {
    return this.tweet(text, { replyTo: tweetId });
  }
}

/**
 * Get appropriate client based on environment
 */
export function getClient(): TwitterClient | MockTwitterClient {
  if (process.env.DRY_RUN === 'true' || !process.env.TWITTER_API_KEY) {
    return new MockTwitterClient();
  }
  return getTwitterClient();
}
