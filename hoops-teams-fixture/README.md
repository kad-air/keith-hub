# hoops-teams-fixture

Recorded ESPN site-API responses for `scripts/check-hoops-teams.ts` (the team,
player and schedule pages under `/hoops/scores`). Fetched 2026-10-29 around
7 AM Mountain, the morning after Utah lost to San Antonio.

| File | Endpoint |
| --- | --- |
| `roster-26.json` | `site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/26/roster` (Utah) |
| `schedule-26.json` | `…/teams/26/schedule?seasontype=2` |
| `schedule-26-pre.json` | `…/teams/26/schedule?seasontype=1` |
| `athlete-3112335.json` | `site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/3112335` (Jokić) |
| `gamelog-3112335.json` | `…/athletes/3112335/gamelog` |
| `athlete-4433136.json` | `…/athletes/4433136` (Walker Kessler) |
| `gamelog-4433136.json` | `…/athletes/4433136/gamelog` |

Trimmed to keep the repo small: every `links`, `logos`, `logo`, `headshot`,
`flag`, `images`, `alternateIds`, `uid`, `guid` and `$ref` key is dropped, and
the athlete responses lose their top-level `playerSwitcher`, `quicklinks`,
`ticketsInfo`, `videos` and `standings` blocks. Nothing the parsers read was
touched; otherwise the JSON is as served.
