/** Synthetic payloads shaped like X's embed endpoint (cdn.syndication.twimg.com/tweet-result). */
import type { RawTweet } from "@/lib/post";

export const photoTweet: RawTweet = {
  __typename: "Tweet",
  id_str: "2116870392300073128",
  lang: "en",
  created_at: "2026-11-01T12:30:05.000Z",
  // "🔥" is one code point but two UTF-16 units: display_text_range must be applied per code point.
  text: "🔥 Tips &amp; tricks: see https://t.co/LINK1 for more https://t.co/MEDIA1",
  display_text_range: [0, 52] as [number, number],
  user: { screen_name: "someone", name: "Some &amp; One" },
  entities: {
    urls: [{ url: "https://t.co/LINK1", expanded_url: "https://example.com/guide" }],
    media: [{ url: "https://t.co/MEDIA1" }],
  },
  mediaDetails: [
    { type: "photo", media_url_https: "https://pbs.twimg.com/media/AAA.jpg", ext_alt_text: "A chart of results" },
    { type: "photo", media_url_https: "https://pbs.twimg.com/media/BBB.png" },
  ],
  photos: [{ url: "https://pbs.twimg.com/media/AAA.jpg" }, { url: "https://pbs.twimg.com/media/BBB.png" }],
};

export const videoTweet: RawTweet = {
  ...photoTweet,
  mediaDetails: [{ type: "video", media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg" }],
  video: { variants: [] },
};

export const quoteTweet: RawTweet = {
  ...photoTweet,
  mediaDetails: [],
  photos: [],
  quoted_tweet: {
    id_str: "9",
    text: "the original take",
    user: { screen_name: "original", name: "Original" },
    mediaDetails: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/QQQ.jpg" }],
  },
};

export const tombstone: RawTweet = { __typename: "TweetTombstone" };

/** Smallest valid JPEG-ish payload: content is irrelevant, only the bytes and type are checked. */
export const fakeImage = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
