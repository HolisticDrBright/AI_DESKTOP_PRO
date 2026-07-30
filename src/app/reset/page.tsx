import { ResetForm } from "@/components/auth/ResetForm";

export default function ResetPage() {
  return (
    <section
      data-screen-label="Reset password"
      className="mx-auto flex min-h-[70vh] max-w-[380px] flex-col justify-center px-6 py-10"
    >
      <h1 className="m-0 mb-1 text-[18px] font-bold tracking-[-0.01em]">Reset password</h1>
      <p className="m-0 mb-5 text-[12.5px] text-subtle">
        Set a new password for your practitioner account.
      </p>
      <ResetForm />
    </section>
  );
}
