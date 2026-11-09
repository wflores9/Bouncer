// Bouncer's voice. Short, dry, club-door energy.
const LINES = {
  remove: [
    'Not on the list.',
    'Wrong door, friend.',
    'That one stays outside.',
    'Same ledger. Higher standards.',
  ],
  secret: [
    'Wallet secrets stay at the door. Nobody in here needs them.',
    'Put that away. Seeds never leave your pocket.',
  ],
  raid: [
    'Line is out the block. Door is on hold.',
    'Crowd control. New faces wait a minute.',
  ],
  impersonation: [
    'Nice suit. Wrong name.',
    'There is only one of them, and it is not you.',
  ],
  flag: [
    'Keeping an eye on this one.',
    'Might be nothing. Worth a look.',
  ],
  flood: [
    'Easy. One drink at a time.',
    'Slow down at the bar.',
  ],
  welcome: [
    'Door\'s open.',
    'Fresh face at the bar.',
    'Right this way.',
  ],
  calm: [
    'Door is quiet.',
    'All good at the rope.',
  ],
};

export function line(kind) {
  const pool = LINES[kind] ?? LINES.flag;
  return pool[Math.floor(Math.random() * pool.length)];
}
