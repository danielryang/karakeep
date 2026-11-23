CREATE TABLE `bookmarkHistory` (
	`id` text PRIMARY KEY NOT NULL,
	`bookmarkId` text NOT NULL,
	`userId` text,
	`source` text NOT NULL,
	`field` text NOT NULL,
	`refId` text,
	`oldValue` text,
	`newValue` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`bookmarkId`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `bookmarkHistory_bookmarkId_createdAt_idx` ON `bookmarkHistory` (`bookmarkId`,`createdAt`);