const { redditExtractor } = require('../dist/services/extractors/reddit');

(async () => {
  const urls = [
    'https://www.reddit.com/r/TeluguFashion/s/O3oMEFuMzi',
    'https://www.reddit.com/r/cats/comments/1vnwvcv/saying_goodbye_to_our_24_year_old_baby/',
    'https://www.reddit.com/r/bollynewsandgossips/s/N4ONsL0IkK'
  ];

  for (const u of urls) {
    console.log('\n==========================================');
    console.log('Testing:', u);
    const res = await redditExtractor.extract(u);
    console.log(JSON.stringify(res, null, 2));
  }
  process.exit(0);
})();
