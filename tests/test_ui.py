from pathlib import Path

import pytest
from playwright.sync_api import expect, sync_playwright

from scripts.ui_capture import demo_server, verify_demo


def test_demo_ui_coverage_and_finding_filters():
    with sync_playwright() as playwright:
        if not Path(playwright.chromium.executable_path).is_file():
            pytest.skip("Install Chromium with: python -m playwright install chromium")
        with demo_server() as url:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                verify_demo(page, url)
                page.get_by_role("textbox", name="Search findings").fill("styles")
                expect(page.locator("#finding-count")).to_have_text("1")
                expect(page.locator("#detail")).to_contain_text("No Tree Impact")
                page.get_by_role("textbox", name="Search findings").fill("")
                page.get_by_role("combobox", name="Filter severity").select_option("high")
                expect(page.locator("#finding-count")).to_have_text("1")
                expect(page.locator("#detail")).to_contain_text("src/Chart.tsx")
                assert errors == []
            finally:
                browser.close()
