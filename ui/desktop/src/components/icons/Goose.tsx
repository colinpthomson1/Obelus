interface GooseProps {
  className?: string;
}

export function Goose({ className = '' }: GooseProps) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <g className="fill-[#1F171F] dark:fill-[#FFFFEB]">
        <rect
          x="15.96"
          y="4.15"
          width="2.25"
          height="4.4"
          rx="1.13"
          transform="rotate(42 17.09 6.35)"
        />
        <rect
          x="18.25"
          y="11.64"
          width="2.25"
          height="4.4"
          rx="1.13"
          transform="rotate(104 19.37 13.84)"
        />
        <rect
          x="12.71"
          y="17.17"
          width="2.25"
          height="4.4"
          rx="1.13"
          transform="rotate(166 13.84 19.37)"
        />
        <rect
          x="5.22"
          y="14.89"
          width="2.25"
          height="4.4"
          rx="1.13"
          transform="rotate(228 6.35 17.09)"
        />
      </g>
      <rect
        x="2.88"
        y="6.34"
        width="2.25"
        height="5.5"
        rx="1.13"
        fill="#F26A50"
        transform="rotate(290 4.01 9.09)"
      />
    </svg>
  );
}
