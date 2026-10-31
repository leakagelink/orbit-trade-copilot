import {createFileRoute} from "@tanstack/react-router";
import {PageHeader} from "@/components/app-shell";
import {SupportMailbox} from "@/components/support-mailbox";
import {toolkitHead} from "@/components/toolkit-shared";
export const Route=createFileRoute("/_authenticated/mailbox")({head:()=>toolkitHead("Support mailbox","Private support conversations, replies and drafts in your AlgoVirt workspace."),component:()=> <div><PageHeader title="Support mailbox" description="Conversations with your support team."/><SupportMailbox/></div>});