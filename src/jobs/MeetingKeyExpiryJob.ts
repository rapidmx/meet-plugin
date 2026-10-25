///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import type { CalendarEventAttendeeLink } from "@rapidmx/restapi";
import type { VideoMeeting, VideoMeetingInvitee } from "../models/types.js";
import { discardMeetingKey } from "../util/MeetingProtectionUtils.js";
const { Config, Init, Logger } = ObjectDecorators;

/** The most meetings one run discards. */
const BATCH = 200;

/**
 * Discards the key of each protected meeting whose `keyExpiresAt` has passed (`specs/meeting_privacy.md` §8): its certificate, every
 * wrap, the guest-readable sealed title and names, and the invitees' join tokens (replaced, so the old links stop resolving), and the
 * keyed attendee links of those invitees (`discardMeetingKey()`). Joining answers 410 from `keyExpiresAt` on whether or not this has
 * run yet. Idempotent: a meeting is marked `keyDiscardedAt` and never selected again, and every replica may run it.
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

    /** The most meetings one run looks at. */
    protected batchSize: number = BATCH;

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
        // Selected by flag, soonest expiry first, and filtered by time here (a date comparison in the query isn't reliable on every
        // backend): every meeting after the first unexpired one expires later still, so the run stops there, and meetings holding a
        // long-lived key can never keep an expired one out of the batch.
        const held: VideoMeeting[] = await this.meetingRepo!.find(
            { keyProtected: true, keyDiscardedAt: null, sort: { keyExpiresAt: "ASC", uid: "ASC" }, limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize, skipCache: true },
        );
        for (const meeting of held) {
            if (!meeting.keyExpiresAt) {
                continue;
            }
            if (new Date(meeting.keyExpiresAt).valueOf() > now) {
                break;
            }
            await this.discard(meeting);
        }
    }

    private async discard(meeting: VideoMeeting): Promise<void> {
        try {
            await discardMeetingKey(meeting, { meetingRepo: this.meetingRepo!, inviteeRepo: this.inviteeRepo!, attendeeLinkRepo: this.attendeeLinkRepo! });
        } catch (err: any) {
            // Changed meanwhile, or the store is unavailable: the next run takes it again (joining is already refused).
            this.logger?.warn(`MeetingKeyExpiryJob: couldn't discard the key of meeting ${meeting.uid} yet: ${err?.message ?? err}`);
        }
    }
}
