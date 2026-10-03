///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for the `@Init` hook (`initialize()`) of `BaseVideoMeetingRoute`, which builds each model repository once
// through the ObjectFactory instead of lazily inside the handlers. (The relay hook is in `RelayBusSelection.test.ts`.)
import { RepoUtils } from "@rapidrest/service-core";
import { BaseVideoMeetingRoute } from "../../src/routes/BaseVideoMeetingRoute.js";

/** A uniquely named stand-in model class. */
function model(name: string): any {
    return { [name]: class {} }[name];
}

class TestRoute extends BaseVideoMeetingRoute<any, any, any> {
    protected meetingClass: any = model("MeetingModel");
    protected inviteeClass: any = model("InviteeModel");
    protected mailboxClass: any = model("MailboxModel");
    protected attendeeLinkClass: any = model("AttendeeLinkModel");
}

/** [repo field, class field] */
const repos: [string, string][] = [
    ["meetingRepo", "meetingClass"],
    ["inviteeRepo", "inviteeClass"],
    ["mailboxRepo", "mailboxClass"],
    ["attendeeLinkRepo", "attendeeLinkClass"],
];

function withFactory(route: any): any {
    const factory: any = { newInstance: vi.fn(async (type: any, opts: any) => ({ type, opts })) };
    Object.defineProperty(route, "_objectFactory", { value: factory, writable: true, configurable: true });
    return factory;
}

describe("BaseVideoMeetingRoute initialize()", () => {
    it("throws when the objectFactory is not set", async () => {
        const route: any = new TestRoute();
        await expect(route.initialize()).rejects.toThrow("objectFactory is not set.");
    });

    it("builds each repo once through the factory with exactly { name, args }", async () => {
        const route: any = new TestRoute();
        const factory = withFactory(route);
        await route.initialize();
        expect(factory.newInstance).toHaveBeenCalledTimes(repos.length);
        for (const [field, classField] of repos) {
            const cls = route[classField];
            expect(factory.newInstance).toHaveBeenCalledWith(RepoUtils, { name: cls.name, args: [cls] });
            expect(route[field]).toEqual({ type: RepoUtils, opts: { name: cls.name, args: [cls] } });
        }
    });

    it("does not rebuild a repo that is already set", async () => {
        const route: any = new TestRoute();
        const factory = withFactory(route);
        const preset: any[] = repos.map(([field]) => (route[field] = { preset: field }));
        await route.initialize();
        expect(factory.newInstance).not.toHaveBeenCalled();
        repos.forEach(([field], i) => expect(route[field]).toBe(preset[i]));
    });

    it("skips a repo whose class is unset", async () => {
        for (const [field, classField] of repos) {
            const route: any = new TestRoute();
            const factory = withFactory(route);
            route[classField] = undefined;
            await route.initialize();
            expect(route[field]).toBeUndefined();
            expect(factory.newInstance).toHaveBeenCalledTimes(repos.length - 1);
        }
    });
});
