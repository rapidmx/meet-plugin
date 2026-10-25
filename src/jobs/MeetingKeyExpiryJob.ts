///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ModelUtils, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import type { CalendarEventAttendeeLink } from "@rapidmx/restapi";
import type { VideoMeeting, VideoMeetingInvitee } from "../models/types.js";
import { mintJoinToken } from "../util/TokenUtils.js";
const { Config, Init, Logger } = ObjectDecorators;

/** The most meetings one run discards. */
const BATCH = 200;

/**
 * Discards the key of each protected meeting whose `keyExpiresAt` has passed (`specs/meeting_privacy.md` §8): its certificate, every
 * wrap, the guest-readable sealed title and names, and the invitees' join tokens (replaced, so the old links stop resolving), and the
 * keyed attendee links of its calendar event. Joining answers 410 from `keyExpiresAt` on whether or not this has run yet. Idempotent: a
 * meeting is marked `keyDiscardedAt` and never selected again, and every replica may run it.
 */
export abstract class MeetingKeyExpiryJob extends BackgroundService {
    protected abstract meetingClass: any;
    protected abstract inviteeClass: any;
    protected abstract attendeeLinkClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    protected meetingRepo?: RepoUtils<VideoMeeting>;
    protected inviteeRepo?: RepoUtils<VideoMeetingInvitee>;
    protected attendeeLinkRepo?: RepoUtils<CalendarEventAttendeeLink>;

    @Config("mail:videoconf:key_expiry:schedule", "0 */5 * * * *")
    private scheduleExpr: string = "0 */5 * * * *";

    @Logger
    protected logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        const repo = async (cls: any): Promise<any> => await this._objectFactory!.newInstance(RepoUtils, { name: cls.name, args: [cls] });
        this.meetingRepo ??= await repo(this.meetingClass);
        this.inviteeRepo ??= await repo(this.inviteeClass);
        this.attendeeLinkRepo ??= await repo(this.attendeeLinkClass);
    }

    public start(): void {
        // Processing happens entirely in `run()`.
    }

    public stop(): void {
        // Nothing to release.
    }

    public async run(): Promise<void> {
        const now: number = Date.now();
        // Selected by flag and filtered by time here: the meetings still holding a key are few, and a date comparison in the query
        // isn't reliable on every backend.
        const held: VideoMeeting[] = await this.meetingRepo!.find({ keyProtected: true, keyDiscardedAt: null, limit: BATCH } as any, {
            ignoreACL: true,
            limit: BATCH,
            skipCache: true,
        });
        for (const meeting of held) {
            if (meeting.keyExpiresAt && new Date(meeting.keyExpiresAt).valueOf() <= now) {
                await this.discard(meeting);
            }
        }
    }

    private async discard(meeting: VideoMeeting): Promise<void> {
        try {
            for (const invitee of await this.inviteeRepo!.find({ meetingUid: ModelUtils.literal(meeting.uid) } as any, { ignoreACL: true })) {
                await this.inviteeRepo!.update(
                    { uid: invitee.uid, version: (invitee as any).version, sealedFields: null, joinToken: mintJoinToken() },
                    invitee,
                    { ignoreACL: true },
                );
            }
            if (meeting.calendarEventUid) {
                const links: CalendarEventAttendeeLink[] = await this.attendeeLinkRepo!.find(
                    { calendarEventUid: ModelUtils.literal(meeting.calendarEventUid), keyed: true } as any,
                    { ignoreACL: true },
                );
                for (const link of links) {
                    await this.attendeeLinkRepo!.delete(link.uid, { ignoreACL: true });
                }
            }
            await this.meetingRepo!.update(
                {
                    uid: meeting.uid,
                    version: (meeting as any).version,
                    meetingKeyCertificate: null,
                    meetingKeyFingerprint: null,
                    keyWraps: null,
                    sealedFields: null,
                    keyDiscardedAt: new Date(),
                },
                meeting,
                { ignoreACL: true },
            );
        } catch (err: any) {
            // Changed meanwhile, or the store is unavailable: the next run takes it again (joining is already refused).
            this.logger?.warn(`MeetingKeyExpiryJob: couldn't discard the key of meeting ${meeting.uid} yet: ${err?.message ?? err}`);
        }
    }
}
