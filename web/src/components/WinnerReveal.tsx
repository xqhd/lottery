import type { CSSProperties } from 'react'

export type Winner = {
  id: string
  name: string
  department: string
}

type Layout = {
  maxWidth: CSSProperties['maxWidth']
  columnGap: number
  rowGap: number
  padding: number
  nameSize: number
  deptSize: number
  showDept: boolean
  delayStepMs: number
  basis?: string
  minWidth?: number
  minHeight?: number
}

function layoutFor(count: number): Layout {
  // All layouts use flex-wrap + justify-center (defined in Stage.css).
  // We only adjust card basis/size so last row is always centered.
  if (count <= 1) {
    return {
      maxWidth: 980,
      columnGap: 36,
      rowGap: 16,
      padding: 34,
      nameSize: 96,
      deptSize: 32,
      showDept: true,
      delayStepMs: 90,
      minHeight: 220,
    }
  }

  if (count <= 4) {
    // Prefer 2x2 for 4, not 3+1.
    return {
      maxWidth: 'min(86vw, 1180px)',
      columnGap: 32,
      rowGap: 18,
      padding: 22,
      nameSize: 56,
      deptSize: 18,
      showDept: true,
      delayStepMs: 80,
      basis: '40%',
      minWidth: 320,
      minHeight: 150,
    }
  }

  if (count <= 7) {
    // 3 per row, last row centered by flex.
    return {
      maxWidth: 'min(86vw, 1200px)',
      columnGap: 32,
      rowGap: 18,
      padding: 18,
      nameSize: 44,
      deptSize: 16,
      showDept: true,
      delayStepMs: 70,
      basis: '30%',
      minWidth: 280,
      minHeight: 120,
    }
  }

  if (count === 8) {
    // Force 4x2.
    return {
      maxWidth: 'min(90vw, 1400px)',
      columnGap: 24,
      rowGap: 16,
      padding: 16,
      nameSize: 38,
      deptSize: 14,
      showDept: true,
      delayStepMs: 60,
      basis: '22%',
      minWidth: 240,
      minHeight: 108,
    }
  }

  if (count === 9) {
    // 3x3 looks cleaner than 4-4-1 for this specific number.
    return {
      maxWidth: 'min(88vw, 1280px)',
      columnGap: 28,
      rowGap: 16,
      padding: 16,
      nameSize: 38,
      deptSize: 14,
      showDept: true,
      delayStepMs: 60,
      basis: '30%',
      minWidth: 260,
      minHeight: 108,
    }
  }

  if (count <= 12) {
    // 10-12: prefer 5 per row (10 => 5x2). 11/12 last row still centered.
    return {
      maxWidth: 'min(92vw, 1560px)',
      columnGap: 18,
      rowGap: 14,
      padding: 14,
      nameSize: 32,
      deptSize: 12,
      showDept: true,
      delayStepMs: 55,
      basis: '18%',
      minWidth: 210,
      minHeight: 96,
    }
  }

  if (count <= 14) {
    // 13-14: keep slightly bigger cards than the high-density mode.
    return {
      maxWidth: 'min(92vw, 1600px)',
      columnGap: 18,
      rowGap: 14,
      padding: 14,
      nameSize: 30,
      deptSize: 12,
      showDept: true,
      delayStepMs: 50,
      basis: '22%',
      minWidth: 200,
      minHeight: 90,
    }
  }

  if (count <= 20) {
    // 15-20: high-density, still prefer 5 per row when possible.
    return {
      maxWidth: 'min(95vw, 1680px)',
      columnGap: 14,
      rowGap: 12,
      padding: 10,
      nameSize: 24,
      deptSize: 10,
      showDept: false,
      delayStepMs: 45,
      basis: '18%',
      minWidth: 180,
      minHeight: 74,
    }
  }

  // 21+: ultra density (6-ish per row).
  return {
    maxWidth: 'min(95vw, 1760px)',
    columnGap: 12,
    rowGap: 10,
    padding: 10,
    nameSize: 22,
    deptSize: 10,
    showDept: false,
    delayStepMs: 35,
    basis: '15%',
    minWidth: 170,
    minHeight: 70,
  }
}

export function WinnerReveal(props: { winners: Winner[] }) {
  const { winners } = props
  const count = winners.length

  if (count === 0) return null

  const layout = layoutFor(count)

  const containerStyle: CSSProperties = {
    maxWidth: layout.maxWidth,
    columnGap: layout.columnGap,
    rowGap: layout.rowGap,
  }

  return (
    <div className="stage-winners" style={containerStyle}>
      {winners.map((w, idx) => {
        const isSolo = count === 1
        const cardStyle: CSSProperties = {
          padding: layout.padding,
          animationDelay: `${idx * layout.delayStepMs}ms`,
          minWidth: layout.minWidth,
          minHeight: layout.minHeight,
          flex: undefined,
        }

        if (!isSolo && layout.basis) {
          cardStyle.flex = `0 1 ${layout.basis}`
        }

        const nameStyle: CSSProperties = {
          fontSize: isSolo ? 120 : layout.nameSize,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '100%',
          textAlign: 'center',
        }

        const deptStyle: CSSProperties = {
          fontSize: isSolo ? 32 : layout.deptSize,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '100%',
          textAlign: 'center',
        }

        return (
          <div className={`stage-winner${isSolo ? ' stage-winner--solo' : ''}`} key={w.id} style={cardStyle}>
            <div className="stage-winner-name" style={nameStyle}>
              {w.name}
            </div>
            {layout.showDept && w.department ? (
              <div className="stage-winner-dept" style={deptStyle}>
                {w.department}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
