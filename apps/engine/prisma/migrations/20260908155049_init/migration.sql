-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nextSeq" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "premise" TEXT NOT NULL,
    "outcomes" JSONB NOT NULL,
    "script" JSONB NOT NULL,
    "reasoning" TEXT,
    "firstHalfUrl" TEXT,
    "branchUrls" JSONB,
    "lockTime" TIMESTAMP(3),
    "drandRound" BIGINT,
    "startTime" TIMESTAMP(3),
    "revealTime" TIMESTAMP(3),
    "outcome" INTEGER,
    "signature" TEXT,
    "createTx" TEXT,
    "resolveTx" TEXT,
    "renderAttempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Canon" (
    "id" SERIAL NOT NULL,
    "channelId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Canon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "World" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "doc" JSONB NOT NULL,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "World_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Event_channelId_state_idx" ON "Event"("channelId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Event_channelId_seq_key" ON "Event"("channelId", "seq");

-- CreateIndex
CREATE INDEX "Canon_channelId_createdAt_idx" ON "Canon"("channelId", "createdAt");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
