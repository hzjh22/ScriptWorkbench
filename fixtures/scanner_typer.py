"""Typer scanner fixture."""

from pathlib import Path
import typer

app = typer.Typer()


@app.command()
def convert(
    input_html: Path = typer.Argument(..., help="Saved HTML"),
    timeout: int = typer.Option(30, "--timeout", help="HTTP timeout"),
    browser_fallback: bool = typer.Option(True, "--browser-fallback"),
):
    """Convert a saved page."""
    pass

