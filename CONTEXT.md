# The World Is Collapsing

Parimutuel betting on the second half of short AI-rendered news-style events, four themed channels, outcomes fixed by drand after lock.

## Language

**Channel**:
One themed programme (sports, politics, culture, region) that airs a sequence of events. The unit of scaling: each channel holds at most one render session at a time.
_Avoid_: stream, feed

**Event**:
One airing on a channel: a first half, a betting window, then the branch matching the drawn outcome.
_Avoid_: round, game, market (a market is one outcome's yes/no pool inside an event)

**Outcome**:
One of the mutually exclusive endings an event can have. Every outcome has a branch rendered before the first bet.
_Avoid_: option, ending, choice

**Branch**:
The rendered second-half video for one outcome.
_Avoid_: second half (that is the on-air phase, not the clip), variant

**Render session**:
One connection to the video vendor that builds and plays every clip of one event in order, and is billed for the seconds it stays open.
_Avoid_: stream, job, generation

**Session slot**:
One of the account's concurrent render sessions. The number of channels can never exceed the number of slots the engine allows itself.
_Avoid_: seat, worker
