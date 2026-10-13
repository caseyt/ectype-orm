# Roadmap

## Planned after the first release

| Feature | Notes |
|---|---|
| Migrations and a CLI | Hand-written, reversible migrations and a runner. Until then, create tables with plain SQL or your existing migration tool. |
| Lateral joins | `joinLateral`, `leftJoinLateral`. |
| `VALUES` lists as a query source | `from(values(...), "v")`. |
| Table-valued fragments | Such as `generate_series` as a source. |
| Index hints | MySQL. |
| Data-modifying CTEs | `UPDATE` or `DELETE` inside a `WITH`. |
| Named server-side prepared statements | For [`prepare`](/guide/queries-advanced#prepared-queries). |
| Form helpers for nested changesets | Sort and drop parameters, and index-keyed objects in place of arrays. |
| Other databases through a custom dialect | |

## Not planned

These are deliberate choices, not gaps:

- **Active-record methods** such as `user.save()`. Rows are data.
- **Lazy loading.** Associations are loaded only when asked for.
- **An identity map or unit of work.** Two queries for the same row return two objects.
- **Implicit transactions.** Only calls on the transaction object are inside it.
- **Generating migrations from schema differences.**
- **Non-SQL stores.**
