// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoginState } from "./state";

const signInAction = vi.fn<(prev: LoginState, data: FormData) => Promise<LoginState>>();
vi.mock("./actions", () => ({
  signInAction: (prev: LoginState, data: FormData) => signInAction(prev, data),
}));

const { LoginForm } = await import("./login-form");

beforeEach(() => signInAction.mockReset());

describe("LoginForm", () => {
  it("explains empty fields without calling the server", async () => {
    render(<LoginForm />);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter your email address.")).toBeInTheDocument();
    expect(screen.getByText("Enter your password.")).toBeInTheDocument();
    expect(signInAction).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Email")).toHaveAccessibleDescription("Enter your email address.");
  });

  it("rejects a malformed email on the client", async () => {
    render(<LoginForm />);
    await userEvent.type(screen.getByLabelText("Email"), "not-an-email");
    await userEvent.type(screen.getByLabelText("Password", { exact: true }), "secret");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/Enter a valid email address/)).toBeInTheDocument();
    expect(signInAction).not.toHaveBeenCalled();
  });

  it("submits valid credentials and shows the server's error in an alert", async () => {
    signInAction.mockResolvedValue({
      status: "error",
      message: "That email and password don't match. Check them and try again.",
      email: "casey@example.com",
    });
    render(<LoginForm />);
    await userEvent.type(screen.getByLabelText("Email"), "casey@example.com");
    await userEvent.type(screen.getByLabelText("Password", { exact: true }), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("don't match");
    expect(signInAction).toHaveBeenCalledTimes(1);
    const sent = signInAction.mock.calls[0]![1];
    expect(sent.get("email")).toBe("casey@example.com");
    expect(sent.get("password")).toBe("wrong-password");
    await waitFor(() => expect(screen.getByLabelText("Email")).toHaveValue("casey@example.com"));
  });

  it("shows a pending state while signing in and prevents double submission", async () => {
    let finish: (state: LoginState) => void = () => undefined;
    signInAction.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<LoginForm />);
    await userEvent.type(screen.getByLabelText("Email"), "casey@example.com");
    await userEvent.type(screen.getByLabelText("Password", { exact: true }), "secret");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    const pending = await screen.findByRole("button", { name: /Signing in/ });
    expect(pending).toBeDisabled();
    finish({ status: "idle" });
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("toggles password visibility with an accessible control", async () => {
    render(<LoginForm />);
    const password = screen.getByLabelText("Password", { exact: true });
    expect(password).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(password).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("carries the destination in a hidden field, only when there is one", () => {
    const { container, rerender } = render(<LoginForm />);
    expect(container.querySelector('input[name="next"]')).toBeNull();
    rerender(<LoginForm next="/staff/orders" />);
    expect(container.querySelector('input[name="next"]')).toHaveValue("/staff/orders");
  });

  it("uses the right autofill hints for a password manager", () => {
    render(<LoginForm />);
    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("Password", { exact: true })).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
  });
});
