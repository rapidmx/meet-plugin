///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { MailboxScopedData } from "@rapidmx/restapi";
import { VideoMeeting, VideoMeetingStatus, VideoMeetingVisibility } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `VideoMeeting` interface for storage in a SQL database. If MongoDB is desired, please use
 * `models.mongo.VideoMeetingMongo` instead.
 *
 * `recordACL: true` - see the `VideoMeeting` interface's own doc comment for why this entity, unlike most of this
 * codebase's mailbox-scoped data, gets its own per-record `AccessControlList`.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@MailboxScopedData()
@Description("A WebRTC video meeting, joinable directly or from a calendar invite.")
@Index("videomeeting_mailbox", ["mailboxUid"])
// Single-field, not `["mailboxUid", "publicSlug"]` - kept identical to the Mongo twin's fix: a compound sparse index
// still indexes a document carrying at least one of its keys (every row has `mailboxUid`), so two private meetings
// in one mailbox (both missing `publicSlug`) would collide on `(mailboxUid, null)`. A single-field sparse index
// skips a document missing the field entirely, matching `join()`'s actual global (not per-mailbox) lookup - see
// `VideoMeeting.publicSlug`'s own doc comment. `organizerSlug` below hit the identical pitfall, fixed the same way.
@Index("videomeeting_public_slug", ["publicSlug"], { unique: true, sparse: true })
@Index("videomeeting_organizer_slug", ["organizerSlug"], { unique: true, sparse: true })
@Protect(
    {
        uid: "VideoMeeting",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    true,
)
export class VideoMeetingSQL extends BaseEntity implements VideoMeeting {
    @Column()
    @Description("The unique identifier of the `Mailbox` that owns this meeting.")
    public mailboxUid: string = "";

    @Column({ nullable: true })
    @Description("The unique identifier of the `CalendarEvent` this meeting was minted for, if any.")
    @Nullable
    public calendarEventUid?: string;

    @Column()
    @Description("The meeting's display title.")
    public title: string = "";

    // `type: "varchar"` is required on every enum-typed column - see `BookingSQL.status`'s own comment for the
    // `emitDecoratorMetadata`/TypeORM reason.
    @Column({ type: "varchar" })
    @Description("Whether this meeting is joinable only by its invitees or by anyone holding its public link.")
    public visibility: VideoMeetingVisibility = VideoMeetingVisibility.PRIVATE;

    @Column({ nullable: true })
    @Description("The public join link's unique identifier, set only when visibility is PUBLIC.")
    @Nullable
    public publicSlug?: string;

    @Column({ nullable: true })
    @Description("The organizer's own join link identifier, set only when visibility is PRIVATE.")
    @Nullable
    public organizerSlug?: string;

    @Column({ type: "varchar" })
    @Description("The current lifecycle state of this meeting.")
    public status: VideoMeetingStatus = VideoMeetingStatus.SCHEDULED;

    @Column({ nullable: true })
    @Description("Informational only: not used for any availability or conflict checking.")
    @Nullable
    public startTime?: Date;

    @Column({ nullable: true })
    @Description("Informational only: not used for any availability or conflict checking.")
    @Nullable
    public endTime?: Date;

    constructor(other?: Partial<VideoMeetingSQL>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.calendarEventUid = "calendarEventUid" in other ? other.calendarEventUid : this.calendarEventUid;
            this.title = other.title !== undefined ? other.title : this.title;
            this.visibility = other.visibility !== undefined ? other.visibility : this.visibility;
            this.publicSlug = "publicSlug" in other ? other.publicSlug : this.publicSlug;
            this.organizerSlug = "organizerSlug" in other ? other.organizerSlug : this.organizerSlug;
            this.status = other.status !== undefined ? other.status : this.status;
            this.startTime = "startTime" in other ? other.startTime : this.startTime;
            this.endTime = "endTime" in other ? other.endTime : this.endTime;
        }
    }
}
