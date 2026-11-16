// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Badge } from "./badge";
import { Button } from "./button";
import { Card, CardDescription, CardHeader, CardTitle } from "./card";

describe("Button", () => {
  it("renders an accessible, clickable button", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Add to order</Button>);

    const button = screen.getByRole("button", { name: "Add to order" });
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("has a 44px minimum touch target by default", () => {
    render(<Button>Pay now</Button>);
    expect(screen.getByRole("button", { name: "Pay now" })).toHaveClass("h-11");
  });

  it("does not fire clicks when disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Pay now
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Pay now" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("can render as a link via asChild without nesting interactive elements", () => {
    render(
      <Button asChild>
        <a href="/menu">Menu</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Menu" });
    expect(link).toHaveAttribute("href", "/menu");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("Badge", () => {
  it("always shows the status as text, not only as colour", () => {
    render(<Badge variant="statusReady">Ready</Badge>);
    const badge = screen.getByText("Ready");
    expect(badge).toBeVisible();
    expect(badge).toHaveClass("bg-status-ready");
  });
});

describe("Card", () => {
  it("renders a titled card", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Scan</CardTitle>
          <CardDescription>Scan the QR code on your table.</CardDescription>
        </CardHeader>
      </Card>,
    );
    expect(screen.getByRole("heading", { name: "Scan" })).toBeInTheDocument();
    expect(screen.getByText("Scan the QR code on your table.")).toBeInTheDocument();
  });
});
