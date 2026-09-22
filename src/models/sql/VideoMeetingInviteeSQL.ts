///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { MailboxScopedData } from "@rapidmx/restapi";
import { VideoMeetingInvitee } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `VideoMeetingInvitee` interface for storage in a SQL database. If MongoDB is desired,
 * please use `models.mongo.VideoMeetingInviteeMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@MailboxScopedData()
@Description("One invited participant of a PRIVATE VideoMeeting, identified by an unguessable join token.")
@Index("videomeetinginvitee_join_token", ["joinToken"], { unique: true })
@Index("videomeetinginvitee_meeting", ["meetingUid"])
@Index("videomeetinginvitee_mailbox", ["mailboxUid"])
@Protect(
    {
        uid: "VideoMeetingInvitee",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class VideoMeetingInviteeSQL extends BaseEntity implements VideoMeetingInvitee {
    @Column()
    @Description("The unique identifier of the `VideoMeeting` this invitee belongs to.")
    public meetingUid: string = "";

    @Column()
    @Description("The unique identifier of the host `Mailbox`, denormalized from the meeting.")
    public mailboxUid: string = "";

    @Column()
    @Description("The invitee's email address, normalized to lowercase.")
    public email: string = "";

    @Column({ nullable: true })
    @Description("The invitee's display name, if supplied.")
    @Nullable
    public displayName?: string;

    @Column()
    @Description("The unguessable token embedded in this invitee's join link. Minted server-side, immutable.")
    public joinToken: string = "";

    constructor(other?: Partial<VideoMeetingInviteeSQL>) {
        super(other);

        if (other) {
            this.meetingUid = other.meetingUid !== undefined ? other.meetingUid : this.meetingUid;
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.email = other.email !== undefined ? other.email : this.email;
            this.displayName = "displayName" in other ? other.displayName : this.displayName;
            this.joinToken = other.joinToken !== undefined ? other.joinToken : this.joinToken;
        }
    }
}
