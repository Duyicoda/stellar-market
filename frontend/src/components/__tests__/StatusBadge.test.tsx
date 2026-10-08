/**
 * Regression test: status.replaceAll() crashed whenever `status` was
 * undefined/null — which happens for real on data fetched through the
 * server-rendered, unauthenticated path (e.g. Job's public response shape
 * omits `status` entirely). StatusBadge is used across jobs, disputes,
 * milestones and applications, so this crashed several different pages.
 */
import "@testing-library/jest-dom";
import { render } from "@testing-library/react";
import StatusBadge from "../StatusBadge";

test("renders nothing instead of crashing when status is missing", () => {
  const { container } = render(<StatusBadge status={undefined} />);
  expect(container).toBeEmptyDOMElement();
});

test("renders nothing instead of crashing when status is null", () => {
  const { container } = render(<StatusBadge status={null} />);
  expect(container).toBeEmptyDOMElement();
});

test("still renders a real status normally", () => {
  const { getByText } = render(<StatusBadge status="IN_PROGRESS" />);
  expect(getByText("IN PROGRESS")).toBeInTheDocument();
});
