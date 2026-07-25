"""Click scanner fixture."""

import click


@click.command()
@click.option("--quality", type=click.Choice(["720p", "1080p"]), default="1080p")
@click.option("--token", required=True, help="Access token")
@click.option("--verbose", is_flag=True)
@click.argument("input_file", type=click.Path())
def main(quality, token, verbose, input_file):
    """Summarize one input file."""
    pass

