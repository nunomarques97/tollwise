# Launch-day checklist

The order and timing for posting the assets in this folder. The maintainer does every step by hand;
nothing here is posted automatically. The times are suggestions, not rules of the channels: move a
step when a channel's current rules or the maintainer's own availability say otherwise, but keep the
order.

## Before launch day (the week before)

1. **The repository is public and complete.** It opens without signing in, CI has passed on the
   default branch, the `v0.1.0` release exists, and the README's images render on GitHub. Follow
   `release-checklist.md` in this folder for those steps.
2. **Every link works on the public repository.** If it is published under a URL other than
   `https://github.com/nunomarques97/tollwise`, replace that URL in every file of this folder. Then
   open each link of each post in a private browser window: the tests check that every linked file
   and heading exists in the repository, not that GitHub serves it.
3. **The numbers are still current.** Run `node benchmarks/savings.ts --verify-latest`; it must exit
   0. If the prices in `catalog/models.yaml` or the routing changed since the last results file, run
   `npm run bench:savings`, update every figure in this folder and the README to the new results
   file, and run `npm test` (the claims tests fail on any figure that does not match its results
   file).
4. **The quick start works from a clean clone**: follow the README's quick start and `npm run demo`
   on a machine that has never run Tollwise.
5. **The channels' current rules are read**: the subreddit rules linked in [`reddit.md`](reddit.md),
   the Show HN guidelines linked in [`show-hn.md`](show-hn.md), and Product Hunt's launch guidelines.
   Rewrite or drop a post that would break them.
6. **Accounts are ready**: a Hacker News account, an X account, a Reddit account that already takes
   part in each target subreddit, and a Product Hunt maker account.
7. **Product Hunt is scheduled** for a Tuesday, Wednesday or Thursday at least a week after day 1,
   from [`product-hunt.md`](product-hunt.md), with the gallery preview checked.

## Day 1: Hacker News and X

Pick a Tuesday, Wednesday or Thursday with the day free to answer questions.

1. **Morning, US Eastern time (around 8 to 10 a.m. ET): Show HN.** Submit the title and URL from
   [`show-hn.md`](show-hn.md), then post the first comment right away. Stay available for the next
   few hours and answer every question plainly, including the critical ones; correct a mistake in a
   reply rather than editing it away. Never ask anyone to upvote.
2. **About an hour after the Show HN: the X thread** from [`x-thread.md`](x-thread.md), all six posts
   as one thread, with the two images attached.
3. **End of the day:** note the questions that came up and any README or docs page that failed to
   answer them; fix those pages before the next post.

## Days 2 to 4: Reddit, one subreddit per day

Post in the morning, US Eastern time, and answer comments through the day. Never post the same text
in two subreddits, and do not cross-post.

1. **Day 2: r/LocalLLaMA**, from [`reddit.md`](reddit.md#rlocalllama).
2. **Day 3: r/selfhosted**, from [`reddit.md`](reddit.md#rselfhosted).
3. **Day 4: r/SideProject**, from [`reddit.md`](reddit.md#rsideproject).

## Product Hunt day

1. **The listing goes live when Product Hunt's day starts, 12:01 a.m. Pacific time.** Post the first
   comment from [`product-hunt.md`](product-hunt.md) as soon as it is live.
2. **Through the day:** answer every comment. Reply to the X thread with the listing link, without
   asking for upvotes.

## After the launch

- Turn repeated questions into README or docs changes, and bug reports into issues.
- Never change a figure in a published post by hand: a new figure needs a new results file and the
  steps of item 3 above.
