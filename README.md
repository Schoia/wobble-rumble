# Wobble Rumble

An online multiplayer party elimination game for 2 to 10 players. Before every round, everyone in the room votes on the course, and the last round crowns a single winner.

## Play

- **Quick play** puts you in a public room. Once 2 or more people are waiting, the show starts automatically after 30 seconds (or when the host presses Start).
- **Create a private room** gives you a 4-letter code and an invite link to send friends. The host starts the show.
- Players who join mid-show, or get knocked out, watch the rest and can still vote.

**Keyboard:** WASD / arrows to move, Space to jump, Shift to dive, drag to look around.
**Touch:** left thumb to move, Jump and Dive buttons on the right, drag the right side to look.

## Courses

| Course | Mode | Goal |
| --- | --- | --- |
| Spinner Steps | Race | Hop spinning bars and bobbing stones to the arch |
| Bumper Alley | Race | Dodge sliding pushers, cross drifting platforms |
| Gate Gamble | Race | Find the doors that burst open |
| Tile Drop | Survival | Hex tiles fall after you touch them |
| Sweeper Ring | Survival | Jump the low bar, stay down for the high one |
| Coin Garden | Collect | Grab the most coins in 45 seconds |
| Crown Peak | Final | First to touch the crown wins |
| Last Tile | Final | Last blob standing wins |

Each round knocks out about a third of the players; once 3 or fewer remain, the final decides the winner (10 players: 10 → 7 → 5 → 3 → final; 2 or 3 players go straight to the final).

## Run it locally

```bash
npm install
npm start
```

Then open http://localhost:3000 in two browser tabs to play against yourself.

## Deploy to Render

The repo includes `render.yaml`, so either:

- **Blueprint:** in Render, choose **New → Blueprint**, pick this repo, and apply; or
- **Manual:** choose **New → Web Service**, pick this repo, and set
  - Runtime: Node
  - Build command: `npm install`
  - Start command: `node server.js`
  - Instance type: Free

Render gives you a URL like `https://wobble-rumble.onrender.com`. Free services sleep after about 15 minutes without visitors, so the first visit after a quiet spell can take up to a minute to load.

## How it works

- `server.js` serves the page and runs rooms over WebSockets. It decides the show: votes, which course is played, who finished or fell, coin counts, and who qualifies.
- `public/index.html` is the whole game (three.js r128). Each browser simulates its own blob and sends its position 20 times a second.
