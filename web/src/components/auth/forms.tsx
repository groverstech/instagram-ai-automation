"use client";
import Link from "next/link";
import { useActionState } from "react";
import { logIn, signUp, type AuthFormState } from "@/app/actions/auth";
import { Button, Field, Input, Notice, Select } from "@/components/ui";

export function LoginForm() {
  const [state, action, pending] = useActionState(logIn, {} as AuthFormState);
  return (
    <form action={action} className="w-full max-w-sm space-y-4">
      <div className="mb-8">
        <h1 className="font-display text-[34px] leading-tight">Welcome back</h1>
        <p className="mt-1 text-muted">Sign in to your workspace.</p>
      </div>
      {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
      <Field label="Email">
        {/* React resets the form after the action; defaultValue brings back what was typed. */}
        <Input name="email" type="email" autoComplete="email" defaultValue={state.values?.email} required />
      </Field>
      <Field label="Password">
        <Input name="password" type="password" autoComplete="current-password" required />
      </Field>
      <Button className="w-full" size="lg" loading={pending}>
        Sign in
      </Button>
      <p className="text-center text-[13px] text-muted">
        New here?{" "}
        <Link href="/signup" className="font-medium text-ink underline-offset-4 hover:underline">
          Create an account
        </Link>
      </p>
    </form>
  );
}

export function SignupForm() {
  const [state, action, pending] = useActionState(signUp, {} as AuthFormState);
  return (
    <form action={action} className="w-full max-w-sm space-y-4">
      <div className="mb-8">
        <h1 className="font-display text-[34px] leading-tight">Create your workspace</h1>
        <p className="mt-1 text-muted">Brands, team and approvals live in your workspace.</p>
      </div>
      {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
      <Field label="Your name">
        <Input name="name" autoComplete="name" defaultValue={state.values?.name} required />
      </Field>
      <Field label="Work email">
        <Input name="email" type="email" autoComplete="email" defaultValue={state.values?.email} required />
      </Field>
      <Field label="Password" hint="8+ characters">
        <Input name="password" type="password" autoComplete="new-password" minLength={8} required />
      </Field>
      <div className="grid grid-cols-[1.4fr_1fr] gap-3">
        <Field label="Workspace name">
          <Input name="workspace" placeholder="Acme Studio" defaultValue={state.values?.workspace} required />
        </Field>
        <Field label="You are">
          {/* A form reset restores a select's initially selected option, so remount it with the typed value. */}
          <Select key={state.values?.type || "business"} name="type" defaultValue={state.values?.type || "business"}>
            <option value="creator">Creator</option>
            <option value="business">Business</option>
            <option value="agency">Agency</option>
          </Select>
        </Field>
      </div>
      <Button className="w-full" size="lg" loading={pending}>
        Create account
      </Button>
      <p className="text-center text-[13px] text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-ink underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
